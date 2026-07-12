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
  const assistantModelVersions = session.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.modelVersion ?? session.modelVersion);
  const modelVersions = [...new Set(
    assistantModelVersions.length > 0 ? assistantModelVersions : [session.modelVersion],
  )];
  const mixedModels = modelVersions.length > 1;
  const messages = session.messages
    .map((message) => {
      const label = message.role === "user"
        ? "用户"
        : mixedModels
          ? `MiniVu（\`${message.modelVersion ?? session.modelVersion}\`）`
          : "MiniVu";
      return `**${label}：** ${message.content}`;
    })
    .join("\n\n");

  return [
    `# ${session.title}`,
    "",
    `模型：${modelVersions.map((modelVersion) => `\`${modelVersion}\``).join("、")}`,
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
