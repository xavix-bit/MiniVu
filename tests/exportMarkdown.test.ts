import { describe, expect, it } from "vitest";
import { renderSessionMarkdown } from "../src/export/exportMarkdown";

describe("renderSessionMarkdown", () => {
  it("renders image, OCR text, and messages", () => {
    const markdown = renderSessionMarkdown({
      title: "MiniVu 会话",
      imageFilename: "session.png",
      ocrText: "Error: connection refused",
      modelVersion: "MiniCPM-V 4.6 GGUF · Q4",
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
    expect(markdown).toContain("处理方式：`MiniVu 本机处理 · 标准`");
    expect(markdown).not.toContain("GGUF");
  });

  it("identifies the model used for each assistant turn in a mixed-model session", () => {
    const markdown = renderSessionMarkdown({
      title: "MiniVu 会话",
      imageFilename: "session.png",
      ocrText: "",
      modelVersion: "MiniCPM-V 4.6 GGUF · Q4",
      messages: [
        { role: "user", content: "先回答这个。" },
        {
          role: "assistant",
          content: "Q4 的回答。",
          modelVersion: "MiniCPM-V 4.6 GGUF · Q4",
        },
        { role: "user", content: "再回答这个。" },
        {
          role: "assistant",
          content: "Q5 的回答。",
          modelVersion: "MiniCPM-V 4.6 GGUF · Q5",
        },
      ],
    });

    expect(markdown).toContain(
      "处理方式：`MiniVu 本机处理 · 标准`、`MiniVu 本机处理 · 高精度`",
    );
    expect(markdown).toContain(
      "**MiniVu（`MiniVu 本机处理 · 标准`）：** Q4 的回答。",
    );
    expect(markdown).toContain(
      "**MiniVu（`MiniVu 本机处理 · 高精度`）：** Q5 的回答。",
    );
  });
});
