use reqwest::Client;
use std::time::Duration;

pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 MiniVu/0.1";

pub fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .cookie_store(true)
        .tcp_keepalive(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())
}

pub fn with_download_headers(
    builder: reqwest::RequestBuilder,
    url: &str,
) -> reqwest::RequestBuilder {
    let builder = builder
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8");
    if url.contains("modelscope.cn") {
        builder.header(reqwest::header::REFERER, "https://modelscope.cn/")
    } else if url.contains("huggingface.co") || url.contains("hf.co") {
        builder.header(reqwest::header::REFERER, "https://huggingface.co/")
    } else {
        builder
    }
}
