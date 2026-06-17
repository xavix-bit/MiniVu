export type AcceptedImage = {
  name: string;
  dataUrl: string;
};

export function isAcceptedImageType(type: string): boolean {
  return type === "image/png" || type === "image/jpeg" || type === "image/webp";
}
