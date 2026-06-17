import { isAcceptedImageType, type AcceptedImage } from "./imageInput";

const MAX_IMAGE_DIMENSION = 2048;

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("读取图片失败"));
    image.src = dataUrl;
  });
}

/** 缩小超大截图，减轻粘贴后的解码、渲染与 OCR 压力 */
export async function normalizeImageDataUrl(dataUrl: string): Promise<string> {
  const image = await loadImageElement(dataUrl);
  const { width, height } = image;
  if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
    return dataUrl;
  }

  const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) {
    return dataUrl;
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export async function readFileAsDataUrl(file: File): Promise<AcceptedImage> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
  const dataUrl = await normalizeImageDataUrl(rawDataUrl);

  return {
    name: file.name || "pasted-image.png",
    dataUrl,
  };
}

export async function readClipboardImage(): Promise<AcceptedImage | null> {
  const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
  const image = await readImage();
  if (!image) {
    return null;
  }

  const { width, height } = await image.size();
  const rgba = await image.rgba();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
  context.putImageData(imageData, 0, 0);
  const dataUrl = await normalizeImageDataUrl(canvas.toDataURL("image/png"));
  return { name: "clipboard.png", dataUrl };
}

export function filterAcceptedFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((file) => isAcceptedImageType(file.type));
}
