import { describe, expect, it } from "vitest";
import { renderSessionMarkdown } from "../src/export/exportMarkdown";

describe("renderSessionMarkdown", () => {
  it("renders image, OCR text, and messages", () => {
    const markdown = renderSessionMarkdown({
      title: "MiniVu 会话",
      imageFilename: "session.png",
      ocrText: "Error: connection refused",
      modelVersion: "MiniCPM-V 4.6 Q4_K_M (GGUF)",
      messages: [
        { role: "user", content: "哪里出了问题？" },
        { role: "assistant", content: "服务拒绝了连接。" },
      ],
    });

    expect(markdown).toContain("# MiniVu 会话");
    expect(markdown).toContain("![当前图片](session.png)");
    expect(markdown).toContain("Error: connection refused");
    expect(markdown).toContain("**用户：** 哪里出了问题？");
    expect(markdown).toContain("**MiniVu：** 服务拒绝了连接。");
    expect(markdown).toContain("模型：`MiniCPM-V 4.6 Q4_K_M (GGUF)`");
  });
});
