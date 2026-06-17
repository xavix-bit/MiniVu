import type { ChatMessage } from "../chat/useImageSession";

export type SessionExport = {
  title: string;
  imageFilename: string;
  ocrText: string;
  modelVersion: string;
  messages: ChatMessage[];
};

function escapeFence(value: string): string {
  return value.replaceAll("```", "'''");
}

export function renderSessionMarkdown(session: SessionExport): string {
  const messages = session.messages
    .map((message) => {
      const label = message.role === "user" ? "用户" : "助手";
      return `**${label}：** ${message.content}`;
    })
    .join("\n\n");

  return [
    `# ${session.title}`,
    "",
    `模型：\`${session.modelVersion}\``,
    "",
    `![当前图片](${session.imageFilename})`,
    "",
    "## 对话",
    "",
    messages,
    "",
    "## 识别文字",
    "",
    "```text",
    escapeFence(session.ocrText),
    "```",
    "",
  ].join("\n");
}
