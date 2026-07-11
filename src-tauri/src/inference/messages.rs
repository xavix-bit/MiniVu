use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
}

const MAX_HISTORY_MESSAGES: usize = 4;
const MAX_HISTORY_MESSAGE_CHARS: usize = 600;

fn truncate_message(content: &str, max_chars: usize) -> String {
    if content.chars().count() <= max_chars {
        return content.to_string();
    }
    let trimmed: String = content.chars().take(max_chars).collect();
    format!("{trimmed}…")
}

pub fn trim_history(history: &[HistoryMessage]) -> Vec<HistoryMessage> {
    let start = history.len().saturating_sub(MAX_HISTORY_MESSAGES);
    history[start..]
        .iter()
        .map(|msg| HistoryMessage {
            role: msg.role.clone(),
            content: truncate_message(&msg.content, MAX_HISTORY_MESSAGE_CHARS),
        })
        .collect()
}

fn summarize_recent_history(history: &[HistoryMessage]) -> String {
    trim_history(history)
        .into_iter()
        .map(|msg| {
            let label = if msg.role == "assistant" {
                "助手"
            } else {
                "用户"
            };
            format!("{label}：{}", msg.content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn build_standalone_follow_up_prompt(
    history: &[HistoryMessage],
    ocr_text: &str,
    prompt: &str,
) -> String {
    let summary = summarize_recent_history(history);
    if summary.is_empty() {
        format_user_text(ocr_text, prompt, true)
    } else {
        format!("以下是刚才的对话摘要：\n{summary}\n\n请结合图片继续回答：{prompt}")
    }
}

fn format_user_text(ocr_text: &str, prompt: &str, include_ocr: bool) -> String {
    if !include_ocr || ocr_text.trim().is_empty() {
        prompt.to_string()
    } else {
        format!("{prompt}\n\n识别文字参考:\n{ocr_text}")
    }
}

fn user_message_with_image(text: &str, image_data_url: &str) -> serde_json::Value {
    serde_json::json!({
        "role": "user",
        "content": [
            { "type": "text", "text": text },
            { "type": "image_url", "image_url": { "url": image_data_url } }
        ]
    })
}

pub fn build_chat_messages(
    history: &[HistoryMessage],
    image_data_url: &str,
    ocr_text: &str,
    prompt: &str,
) -> Vec<serde_json::Value> {
    let mut messages: Vec<serde_json::Value> = history
        .iter()
        .map(|msg| {
            serde_json::json!({
                "role": msg.role,
                "content": msg.content
            })
        })
        .collect();

    let include_ocr = history.is_empty();
    let current_text = format_user_text(ocr_text, prompt, include_ocr);
    messages.push(user_message_with_image(&current_text, image_data_url));

    messages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_history_keeps_last_four_messages() {
        let history: Vec<HistoryMessage> = (0..6)
            .map(|index| HistoryMessage {
                role: "user".to_string(),
                content: format!("message-{index}"),
            })
            .collect();
        let trimmed = trim_history(&history);
        assert_eq!(trimmed.len(), 4);
        assert_eq!(trimmed[0].content, "message-2");
        assert_eq!(trimmed[3].content, "message-5");
    }

    #[test]
    fn build_chat_messages_includes_ocr_only_on_first_turn() {
        let first = build_chat_messages(&[], "data:image/png;base64,abc", "OCR", "prompt");
        let text = first[0]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("OCR"));

        let follow_up = build_chat_messages(
            &[HistoryMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            "data:image/png;base64,abc",
            "OCR",
            "prompt",
        );
        let follow_text = follow_up[1]["content"][0]["text"].as_str().unwrap();
        assert!(!follow_text.contains("OCR"));
        assert_eq!(follow_text, "prompt");
    }
}
