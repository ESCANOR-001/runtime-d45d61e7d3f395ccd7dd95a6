use crate::{Request, Result};
use serde_json::{Value, json};
#[cfg(target_os = "linux")]
mod linux;

pub fn execute(request: Request) -> Result<Value> {
    if matches!(request, Request::Info {}) {
        return Ok(json!({"protocolVersion":1,"platform":std::env::consts::OS,
            "architecture":std::env::consts::ARCH,"backend":"native-accessibility",
            "available":cfg!(target_os = "linux")}));
    }
    #[cfg(target_os = "linux")]
    {
        linux::execute(request)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(format!(
            "Claude native control on {} is not implemented yet.",
            std::env::consts::OS
        ))
    }
}
