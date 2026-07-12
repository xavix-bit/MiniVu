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
          <strong>本机文字识别</strong>
          <p>图片文字不离开这台 Mac。</p>
        </article>
        <article>
          <span aria-hidden="true">LLM</span>
          <strong>本地识图问答</strong>
          <p>问题、回答和对话在本机处理。</p>
        </article>
        <article>
          <span aria-hidden="true">NET</span>
          <strong>只在需要时联网</strong>
          <p>下载、安装、测速或检查更新时联网。</p>
        </article>
      </div>
    </section>
  );
}
