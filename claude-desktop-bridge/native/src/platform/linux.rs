use crate::{Request, Result, Target};
use base64::{Engine, engine::general_purpose::STANDARD};
use gio::{
    DBusCallFlags, DBusConnection, DBusConnectionFlags,
    glib::{self, variant::ToVariant},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    process::{Command, Stdio},
    time::Instant,
};

const ROOT: &str = "/org/a11y/atspi/accessible/root";
const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const COMPONENT: &str = "org.a11y.atspi.Component";
const PROPS: &str = "org.freedesktop.DBus.Properties";
const CLIP_LIMIT: u64 = 16 * 1024 * 1024;
struct Desktop {
    connection: DBusConnection,
    bus: String,
}
fn err(_: impl std::fmt::Display) -> String {
    "Claude accessibility is unavailable. Keep Desktop open and refresh.".into()
}
fn string(v: glib::Variant) -> Result<String> {
    v.str().map(str::to_owned).ok_or_else(|| err("string"))
}
fn attrs(v: glib::Variant) -> Result<HashMap<String, String>> {
    v.get().ok_or_else(|| err("attributes"))
}
fn call(
    c: &DBusConnection,
    bus: &str,
    path: &str,
    interface: &str,
    method: &str,
    args: Option<&glib::Variant>,
    timeout: i32,
) -> Result<glib::Variant> {
    c.call_sync(
        Some(bus),
        path,
        interface,
        method,
        args,
        None,
        DBusCallFlags::NONE,
        timeout,
        gio::Cancellable::NONE,
    )
    .map_err(err)
}
fn children(v: glib::Variant) -> Result<Vec<(String, String)>> {
    (0..v.n_children())
        .map(|i| {
            let row = v.child_value(i);
            Ok((string(row.child_value(0))?, string(row.child_value(1))?))
        })
        .collect()
}
impl Desktop {
    fn new() -> Result<Self> {
        let session =
            gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).map_err(err)?;
        let address = string(
            call(
                &session,
                "org.a11y.Bus",
                "/org/a11y/bus",
                "org.a11y.Bus",
                "GetAddress",
                None,
                1500,
            )?
            .child_value(0),
        )?;
        let connection = DBusConnection::for_address_sync(
            &address,
            DBusConnectionFlags::AUTHENTICATION_CLIENT
                | DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
            None,
            gio::Cancellable::NONE,
        )
        .map_err(err)?;
        let entries = children(
            call(
                &connection,
                "org.a11y.atspi.Registry",
                ROOT,
                ACCESSIBLE,
                "GetChildren",
                None,
                1500,
            )?
            .child_value(0),
        )?;
        let mut apps = Vec::new();
        for (bus, path) in entries {
            if let Ok(v) = call(
                &connection,
                &bus,
                &path,
                PROPS,
                "Get",
                Some(&(ACCESSIBLE, "Name").to_variant()),
                150,
            ) {
                if v.child_value(0)
                    .as_variant()
                    .and_then(|v| v.str().map(str::to_owned))
                    .as_deref()
                    == Some("claude-desktop")
                {
                    apps.push(bus);
                }
            }
        }
        if apps.len() != 1 {
            return Err("Open one Claude Desktop instance in this Linux desktop session.".into());
        }
        Ok(Self {
            connection,
            bus: apps.remove(0),
        })
    }
    fn call(
        &self,
        path: &str,
        interface: &str,
        method: &str,
        args: Option<&glib::Variant>,
    ) -> Result<glib::Variant> {
        call(
            &self.connection,
            &self.bus,
            path,
            interface,
            method,
            args,
            1500,
        )
    }
    fn name(&self, path: &str) -> Result<String> {
        let v = self
            .call(path, PROPS, "Get", Some(&(ACCESSIBLE, "Name").to_variant()))?
            .child_value(0)
            .as_variant()
            .ok_or_else(|| err("name"))?;
        string(v)
    }
    fn verify(&self, t: &Target) -> Result<()> {
        if t.application != self.bus || !t.id.starts_with("/org/a11y/atspi/accessible/") {
            return Err("Desktop application changed. Refresh before acting.".into());
        }
        if self.name(&t.id)? != t.name
            || string(
                self.call(&t.id, ACCESSIBLE, "GetRoleName", None)?
                    .child_value(0),
            )? != t.role
        {
            return Err("Desktop control changed. Refresh before acting.".into());
        }
        Ok(())
    }
    fn scan(&self) -> Result<Value> {
        let mut pending = vec![(ROOT.to_string(), None::<String>, 0usize)];
        let mut nodes = serde_json::Map::new();
        let mut order = Vec::new();
        let start = Instant::now();
        while let Some((path, parent, depth)) = pending.pop() {
            if nodes.contains_key(&path) {
                continue;
            }
            if nodes.len() >= 12000 || depth > 256 || start.elapsed().as_secs() >= 10 {
                return Err("Claude accessibility tree is too large or not responding. Open a shorter chat.".into());
            }
            let name = self.name(&path)?;
            let attributes = attrs(
                self.call(&path, ACCESSIBLE, "GetAttributes", None)?
                    .child_value(0),
            )?;
            let role = string(
                self.call(&path, ACCESSIBLE, "GetRoleName", None)?
                    .child_value(0),
            )?;
            let kids: Vec<String> = children(
                self.call(&path, ACCESSIBLE, "GetChildren", None)?
                    .child_value(0),
            )?
            .into_iter()
            .filter(|(bus, _)| bus == &self.bus)
            .map(|(_, p)| p)
            .collect();
            let mut node = json!({"name":name,"role":role,"parent":parent,"children":kids,"class":attributes.get("class").cloned().unwrap_or_default(),"attrs":attributes});
            if role == "link" {
                if let Ok(v) = self.call(
                    &path,
                    "org.a11y.atspi.Hyperlink",
                    "GetURI",
                    Some(&(0i32,).to_variant()),
                ) {
                    node["uri"] = json!(string(v.child_value(0))?);
                }
            }
            if role == "document web" {
                node["document"] = json!(attrs(
                    self.call(&path, "org.a11y.atspi.Document", "GetAttributes", None)?
                        .child_value(0)
                )?);
            }
            for child in kids.iter().rev() {
                pending.push((child.clone(), Some(path.clone()), depth + 1));
            }
            order.push(path.clone());
            nodes.insert(path, node);
        }
        Ok(json!({"application":self.bus,"nodes":nodes,"order":order}))
    }
}
fn command(program: &str, args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|_| format!("Required desktop utility {program} is unavailable."))?;
    if !output.status.success() {
        return Err(format!(
            "Desktop utility {program} could not complete the action."
        ));
    }
    Ok(output.stdout)
}
fn clipboard_read() -> Result<Value> {
    let formats = command("wl-paste", &["--list-types"]).unwrap_or_default();
    let formats = String::from_utf8_lossy(&formats);
    let formats: Vec<&str> = formats.lines().collect();
    if formats.len() > 1
        && !formats.iter().all(|f| {
            [
                "text/plain",
                "text/plain;charset=utf-8",
                "UTF8_STRING",
                "TEXT",
                "STRING",
            ]
            .contains(f)
        })
    {
        return Err(
            "Clipboard contains multiple formats. Copy plain text before remote control.".into(),
        );
    }
    let mime = if formats.contains(&"text/plain;charset=utf-8") {
        Some("text/plain;charset=utf-8")
    } else {
        formats.first().copied()
    };
    let Some(mime) = mime else {
        return Ok(json!({"mime":null,"data":""}));
    };
    let mut child = Command::new("wl-paste")
        .args(["--no-newline", "--type", mime])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(err)?;
    let mut data = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| err("stdout"))?
        .take(CLIP_LIMIT + 1)
        .read_to_end(&mut data)
        .map_err(err)?;
    if data.len() as u64 > CLIP_LIMIT {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Clipboard is too large to preserve safely.".into());
    }
    if !child.wait().map_err(err)?.success() {
        return Err("Could not preserve clipboard.".into());
    }
    Ok(json!({"mime":mime,"data":STANDARD.encode(data)}))
}
fn clipboard_write(mime: Option<String>, data: String) -> Result<Value> {
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "Invalid clipboard payload.")?;
    if bytes.len() as u64 > CLIP_LIMIT {
        return Err("Clipboard payload is too large.".into());
    }
    if mime.is_none() {
        command("wl-copy", &["--clear"])?;
        return Ok(json!({}));
    }
    let mime = mime.unwrap();
    if mime.len() > 128 || mime.contains(['\0', '\n', '\r']) {
        return Err("Invalid clipboard format.".into());
    }
    let mut child = Command::new("wl-copy")
        .args(["--type", &mime])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(err)?;
    child
        .stdin
        .take()
        .ok_or_else(|| err("stdin"))?
        .write_all(&bytes)
        .map_err(err)?;
    if !child.wait().map_err(err)?.success() {
        return Err("Could not prepare clipboard.".into());
    }
    Ok(json!({}))
}
pub fn execute(request: Request) -> Result<Value> {
    match request {
        Request::ClipboardRead {} => return clipboard_read(),
        Request::ClipboardWrite { mime, data } => return clipboard_write(mime, data),
        Request::Activate {} => {
            let windows = command(
                "xdotool",
                &[
                    "search",
                    "--onlyvisible",
                    "--class",
                    r"^com\.anthropic\.Claude$",
                ],
            )?;
            let windows = String::from_utf8_lossy(&windows);
            let windows: Vec<&str> = windows.lines().collect();
            if windows.len() != 1 {
                return Err(
                    "Start one Claude Desktop with --ozone-platform=x11 for Linux remote control."
                        .into(),
                );
            }
            command("xdotool", &["windowactivate", windows[0]])?;
            return Ok(json!({}));
        }
        _ => {}
    }
    let desktop = Desktop::new()?;
    let (target, method) = match &request {
        Request::Scan {} => return desktop.scan(),
        Request::Action { target } => (target, "DoAction"),
        Request::Focus { target } => (target, "GrabFocus"),
        Request::Scroll { target } => (target, "ScrollTo"),
        Request::Hover { target } => (target, "GetExtents"),
        _ => return Err("Unsupported native action.".into()),
    };
    desktop.verify(target)?;
    let args = match request {
        Request::Action { .. } => Some((0i32,).to_variant()),
        Request::Scroll { .. } => Some((1u32,).to_variant()),
        Request::Hover { .. } => Some((0u32,).to_variant()),
        _ => None,
    };
    let interface = if method == "DoAction" {
        "org.a11y.atspi.Action"
    } else {
        COMPONENT
    };
    let result = desktop.call(&target.id, interface, method, args.as_ref())?;
    if method == "GetExtents" {
        let (x, y, w, h) = result
            .child_value(0)
            .get::<(i32, i32, i32, i32)>()
            .ok_or_else(|| err("bounds"))?;
        if w <= 0 || h <= 0 {
            return Err("Desktop control is not visible.".into());
        }
        command(
            "xdotool",
            &[
                "mousemove",
                &(x + w / 2).to_string(),
                &(y + h / 2).to_string(),
            ],
        )?;
    } else if result.child_value(0).get::<bool>() != Some(true) {
        return Err("Claude did not accept the action.".into());
    }
    Ok(json!({}))
}
