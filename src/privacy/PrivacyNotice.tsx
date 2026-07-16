import { Clock3, MessageSquareText, ScanText } from "lucide-react";

export function PrivacyNotice() {
  return (
    <section className="privacy-product" aria-label="隐私说明">
      <div className="privacy-product__hero">
        <p className="privacy-product__eyebrow">本地优先</p>
        <h2>图片和对话留在这台 Mac</h2>
      </div>

      <div className="privacy-product__grid">
        <article>
          <span aria-hidden="true"><ScanText size={18} /></span>
          <strong>识别文字</strong>
          <p>本机读取图片文字。</p>
        </article>
        <article>
          <span aria-hidden="true"><MessageSquareText size={18} /></span>
          <strong>回答图片问题</strong>
          <p>本机回答图片问题。</p>
        </article>
        <article>
          <span aria-hidden="true"><Clock3 size={18} /></span>
          <strong>记录由你控制</strong>
          <p>截图默认保留 24 小时，固定后不会自动删除。</p>
        </article>
      </div>
    </section>
  );
}
