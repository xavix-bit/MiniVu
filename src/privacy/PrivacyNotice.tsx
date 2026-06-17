export function PrivacyNotice() {
  return (
    <section className="settings-card privacy-notice" aria-label="隐私说明">
      <p>
        图片、识别文字、提问与回答均保留在本设备。仅在您主动下载或更新模型时才会使用网络。
      </p>
      <ul className="privacy-points">
        <li>识图面板中的图片与对话不会上传到任何云端服务</li>
        <li>OCR 识别在本地完成，使用 macOS Vision 框架</li>
        <li>模型推理在本机完成（Apple Silicon 上使用 MLX，其他平台使用 llama.cpp），数据不出设备</li>
        <li>导出 Markdown 仅写入你选择的本地路径</li>
      </ul>
    </section>
  );
}
