// Private stdin/stdout protocol. No listener, credentials, or account API access.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
mod platform;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Write};

pub type Result<T> = std::result::Result<T, String>;
const MAX_INPUT: u64 = 24 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Info {},
    Scan {},
    Action { target: Target },
    Focus { target: Target },
    Scroll { target: Target },
    Hover { target: Target },
    Activate {},
    ClipboardRead {},
    ClipboardWrite { mime: Option<String>, data: String },
}

#[derive(Debug, Deserialize)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub application: String,
    pub id: String,
    pub name: String,
    pub role: String,
}

fn execute(input: &[u8]) -> Value {
    let result = serde_json::from_slice::<Request>(input)
        .map_err(|_| "Invalid native helper request.".to_string())
        .and_then(platform::execute);
    match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => json!({"ok":false,"error":error}),
    }
}

fn main() {
    let mut input = Vec::new();
    let response = match std::io::stdin().take(MAX_INPUT + 1).read_to_end(&mut input) {
        Ok(_) if input.len() as u64 <= MAX_INPUT => execute(&input),
        _ => json!({"ok":false,"error":"Native request exceeds the input limit."}),
    };
    let success = response["ok"] == true;
    let mut out = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, &response);
    let _ = out.write_all(b"\n");
    if !success {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_operations_and_fields() {
        for input in [
            r#"{"op":"shell","command":"anything"}"#,
            r#"{"op":"info","token":"secret"}"#,
        ] {
            let result = execute(input.as_bytes());
            assert_eq!(result["ok"], false);
            assert!(!result.to_string().contains("secret"));
        }
    }
    #[test]
    fn info_is_versioned_and_does_not_require_a_desktop_session() {
        let result = execute(br#"{"op":"info"}"#);
        assert_eq!(result["ok"], true);
        assert_eq!(result["result"]["protocolVersion"], 1);
    }
    #[test]
    fn mutations_require_complete_target_identity() {
        assert!(
            serde_json::from_str::<Request>(r#"{"op":"action","target":{"id":"123"}}"#).is_err()
        );
    }
}
