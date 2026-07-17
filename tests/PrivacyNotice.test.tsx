import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PrivacyNotice } from "../src/privacy/PrivacyNotice";

describe("PrivacyNotice", () => {
  it("states the privacy promise without repeating implementation details", () => {
    render(<PrivacyNotice />);

    expect(screen.getByRole("heading", { name: "数据留在这台 Mac" })).toBeVisible();
    expect(screen.getByText("截图和识别结果")).toBeVisible();
    expect(screen.getByText("只保存在这台 Mac。")).toBeVisible();
    expect(screen.getByText("自动清理")).toBeVisible();
    expect(screen.queryByText("本地优先")).not.toBeInTheDocument();
    expect(screen.queryByText("本机回答图片问题。")).not.toBeInTheDocument();
  });
});
