type QuickActionsProps = {
  onSelect: (prompt: string) => void;
};

const actions = [
  { label: "总结", prompt: "请总结这张图片的内容。" },
  { label: "提取文字", prompt: "请提取图片中的可见文字。" },
  { label: "解释内容", prompt: "请解释这张图片里正在发生什么。" },
  { label: "查找问题", prompt: "请找出这张图片中的问题、风险或错误。" },
];

export function QuickActions({ onSelect }: QuickActionsProps) {
  return (
    <div className="quick-actions" aria-label="快捷操作">
      {actions.map((action) => (
        <button key={action.label} type="button" onClick={() => onSelect(action.prompt)}>
          {action.label}
        </button>
      ))}
    </div>
  );
}
