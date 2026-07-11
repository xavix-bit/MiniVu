export function PrivacyNotice() {
  return (
    <section className="privacy-product" aria-label="隐私说明">
      <div className="privacy-product__hero">
        <p className="privacy-product__eyebrow">本地优先</p>
        <h2>图片和对话留在这台 Mac</h2>
      </div>

      <div className="privacy-product__grid">
        <article>
          <span aria-hidden="true">OCR</span>
          <strong>系统级文字识别</strong>
          <p>本机读取图片文字。</p>
        </article>
        <article>
          <span aria-hidden="true">LLM</span>
          <strong>本地视觉推理</strong>
          <p>本机回答图片问题。</p>
        </article>
        <article>
          <span aria-hidden="true">MD</span>
          <strong>导出路径可控</strong>
          <p>主动导出时才写入文件。</p>
        </article>
      </div>
    </section>
  );
}
