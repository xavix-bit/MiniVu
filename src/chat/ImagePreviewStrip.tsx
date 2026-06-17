type ImagePreviewStripProps = {
  dataUrl: string;
  name: string;
  compact?: boolean;
};

export function ImagePreviewStrip({ dataUrl, name, compact = false }: ImagePreviewStripProps) {
  return (
    <div className={`image-preview-strip${compact ? " image-preview-strip--compact" : ""}`}>
      <img src={dataUrl} alt={name} decoding="async" />
    </div>
  );
}
