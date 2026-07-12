import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportCurrentSession, modelLabelForExport } from "../src/export/exportSession";
import type { ImageSessionState } from "../src/chat/useImageSession";
import type { ModelStatusResponse } from "../src/model/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const openMock = vi.mocked(open);
const invokeMock = vi.mocked(invoke);

const session: ImageSessionState = {
  image: { name: "screen.png", dataUrl: "data:image/png;base64,abc" },
  ocrText: "本地文字",
  messages: [{ role: "user", content: "这是什么？" }],
};

const q4Session: ImageSessionState = {
  ...session,
  messages: [
    { role: "user", content: "这是什么？" },
    {
      role: "assistant",
      content: "这是本地回答。",
      modelVersion: "MiniCPM-V 4.6 Q4_K_M (GGUF)",
    },
  ],
};

const status: ModelStatusResponse = {
  modelReady: true,
  modelDownloaded: true,
  mmprojDownloaded: true,
  modelPath: "/models/q5.gguf",
  mmprojPath: "/models/mmproj.gguf",
  modelSize: "1.57 GiB",
  sidecarRunning: true,
  llamaServerAvailable: true,
  inferenceBackend: "llama",
  ggufModelVariant: "q5_k_m",
  ggufVariants: [],
  modelStorageBytes: 1_686_549_888,
  activeBackend: "llama",
  mlxRuntimeAvailable: false,
  mlxModelId: "",
  mlxModelReady: false,
  mlxRequiresNetwork: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  openMock.mockResolvedValue("/tmp/export");
  invokeMock.mockResolvedValue("/tmp/export/session.md");
});

describe("modelLabelForExport", () => {
  it("uses the active GGUF variant", () => {
    expect(modelLabelForExport(status)).toBe("MiniCPM-V 4.6 Q5_K_M (GGUF)");
  });

  it("uses the configured MLX model id", () => {
    expect(modelLabelForExport({
      ...status,
      inferenceBackend: "mlx",
      mlxModelId: "mlx-community/MiniCPM-V-4.6-4bit",
    })).toBe("mlx-community/MiniCPM-V-4.6-4bit");
  });
});

describe("exportCurrentSession", () => {
  it("uses a neutral label when no model status is available", async () => {
    await exportCurrentSession(session);

    expect(invokeMock).toHaveBeenCalledWith("export_session", {
      request: expect.objectContaining({
        markdown: expect.stringContaining("模型：`MiniVu local model`"),
      }),
    });
  });

  it("writes the model recorded on the assistant turn", async () => {
    await exportCurrentSession(q4Session);

    expect(invokeMock).toHaveBeenCalledWith("export_session", {
      request: expect.objectContaining({
        markdown: expect.stringContaining("模型：`MiniCPM-V 4.6 Q4_K_M (GGUF)`"),
      }),
    });
  });

  it("writes every recorded model for a mixed-model session", async () => {
    await exportCurrentSession({
      ...q4Session,
      messages: [
        ...q4Session.messages,
        { role: "user", content: "再回答一次。" },
        {
          role: "assistant",
          content: "这是清晰模型的回答。",
          modelVersion: "MiniCPM-V 4.6 Q5_K_M (GGUF)",
        },
      ],
    });

    expect(invokeMock).toHaveBeenCalledWith("export_session", {
      request: expect.objectContaining({
        markdown: expect.stringContaining(
          "模型：`MiniCPM-V 4.6 Q4_K_M (GGUF)`、`MiniCPM-V 4.6 Q5_K_M (GGUF)`",
        ),
      }),
    });
  });
});
