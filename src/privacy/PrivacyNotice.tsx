import { Clock3, ScanText } from "lucide-react";

export function PrivacyNotice() {
  return (
    <section className="privacy-product" aria-label="隐私说明">
      <div className="privacy-product__hero">
        <h2>数据留在这台 Mac</h2>
      </div>

      <div className="privacy-product__grid">
        <article>
          <span aria-hidden="true"><ScanText size={18} /></span>
          <strong>截图和识别结果</strong>
          <p>只保存在这台 Mac。</p>
        </article>
        <article>
          <span aria-hidden="true"><Clock3 size={18} /></span>
          <strong>自动清理</strong>
          <p>截图默认保留 24 小时；固定的截图不会自动删除。</p>
        </article>
      </div>
    </section>
  );
}
