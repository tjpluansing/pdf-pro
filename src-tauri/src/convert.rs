//! Converts between PDF and Office formats by running LibreOffice in the
//! background (`soffice --headless --convert-to`). LibreOffice is a separate
//! program (MPL-2.0) shipped next to the app; it is run, never linked.
//!
//! Where it looks for LibreOffice, in order:
//! 1. `PDFPRO_SOFFICE`, a path to the `soffice` program (for testing).
//! 2. The copy bundled with the app, in its resources folder.
//! 3. A copy installed on the computer in the usual place.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

/// Longest a single conversion may run before it is stopped.
const TIMEOUT: Duration = Duration::from_secs(180);

/// LibreOffice can't share its profile between two runs, so conversions take turns.
static BUSY: Mutex<()> = Mutex::new(());

/// What to convert to. Each maps to LibreOffice's filter for that format.
fn target(to: &str) -> Option<(&'static str, &'static str, Option<&'static str>)> {
  // (extension of the output, --convert-to argument, --infilter for the input)
  match to {
    "pdf" => Some(("pdf", "pdf", None)),
    // PDFs open in Draw by default; Writer's import keeps text as editable paragraphs.
    "docx" => Some(("docx", "docx:MS Word 2007 XML", Some("writer_pdf_import"))),
    _ => None,
  }
}

/// The file types LibreOffice is asked to turn into PDF.
const OFFICE: &[&str] = &[
  "doc", "docx", "odt", "rtf", "txt", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp",
];

/// Converts the file in the request body. Headers: `x-name` (the original
/// file name, for its extension) and `x-to` (`pdf` or `docx`). Returns the
/// converted file's bytes.
#[tauri::command]
pub async fn convert(app: AppHandle, request: Request<'_>) -> Result<Response, String> {
  let InvokeBody::Raw(bytes) = request.body() else {
    return Err("Expected the file's bytes".into());
  };
  let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
  let name = header("x-name").ok_or("Missing the file name")?;
  let to = header("x-to").ok_or("Missing the format to convert to")?;
  let bytes = bytes.clone();
  let exe = soffice(&app).ok_or(
    "LibreOffice, which converts Office files, is missing. Reinstall PDF Pro, or install LibreOffice from libreoffice.org.",
  )?;
  let profile = app
    .path()
    .app_cache_dir()
    .map_err(|e| e.to_string())?
    .join("libreoffice-profile");
  let out = tauri::async_runtime::spawn_blocking(move || run(&exe, &profile, &name, &to, &bytes))
    .await
    .map_err(|e| e.to_string())??;
  Ok(Response::new(out))
}

fn run(exe: &Path, profile: &Path, name: &str, to: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
  let (ext, filter, infilter) = target(to).ok_or_else(|| format!("Can't convert to {to}"))?;
  let input_ext = Path::new(name)
    .extension()
    .and_then(|e| e.to_str())
    .map(str::to_ascii_lowercase)
    .unwrap_or_default();
  let allowed = if to == "pdf" { OFFICE.contains(&input_ext.as_str()) } else { input_ext == "pdf" };
  if !allowed {
    return Err(format!("Can't convert a .{input_ext} file to {to}"));
  }

  let _turn = BUSY.lock().unwrap_or_else(|e| e.into_inner());
  let dir = tempdir()?;
  let result = (|| {
    // A fixed, plain name avoids trouble with characters LibreOffice dislikes in paths.
    let input = dir.join(format!("input.{input_ext}"));
    let outdir = dir.join("out");
    fs::write(&input, bytes).map_err(|e| e.to_string())?;
    fs::create_dir_all(&outdir).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(exe);
    cmd.arg("--headless")
      .arg("--norestore")
      .arg("--nolockcheck")
      .arg(format!("-env:UserInstallation={}", file_url(profile)));
    if let Some(f) = infilter {
      cmd.arg(format!("--infilter={f}"));
    }
    cmd.arg("--convert-to").arg(filter).arg("--outdir").arg(&outdir).arg(&input);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      const CREATE_NO_WINDOW: u32 = 0x0800_0000;
      cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Could not start LibreOffice: {e}"))?;
    let started = Instant::now();
    let status = loop {
      if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
        break s;
      }
      if started.elapsed() > TIMEOUT {
        let _ = child.kill();
        let _ = child.wait();
        return Err("The conversion took too long and was stopped".into());
      }
      std::thread::sleep(Duration::from_millis(50));
    };

    let output = outdir.join(format!("input.{ext}"));
    match fs::read(&output) {
      Ok(b) if !b.is_empty() => Ok(b),
      _ => {
        log::warn!("LibreOffice failed ({status})");
        Err("LibreOffice could not convert this file. It may be damaged or password protected.".into())
      }
    }
  })();
  let _ = fs::remove_dir_all(&dir);
  result
}

fn tempdir() -> Result<PathBuf, String> {
  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  let dir = std::env::temp_dir().join(format!("pdf-pro-convert-{}-{stamp}", std::process::id()));
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

/// LibreOffice wants its profile as a file:// URL.
fn file_url(p: &Path) -> String {
  let s = p.to_string_lossy().replace('\\', "/");
  let s = s.replace(' ', "%20");
  if s.starts_with('/') { format!("file://{s}") } else { format!("file:///{s}") }
}

fn soffice(app: &AppHandle) -> Option<PathBuf> {
  if let Some(p) = std::env::var_os("PDFPRO_SOFFICE").map(PathBuf::from) {
    return p.is_file().then_some(p);
  }
  let mut candidates = Vec::new();
  if let Ok(res) = app.path().resource_dir() {
    let lo = res.join("libreoffice");
    candidates.push(lo.join("program").join("soffice.exe"));
    candidates.push(lo.join("LibreOffice.app/Contents/MacOS/soffice"));
    candidates.push(lo.join("program").join("soffice"));
  }
  if cfg!(windows) {
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
      if let Some(dir) = std::env::var_os(var) {
        candidates.push(PathBuf::from(dir).join("LibreOffice/program/soffice.exe"));
      }
    }
  } else if cfg!(target_os = "macos") {
    candidates.push(PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"));
  } else {
    for dir in ["/usr/bin", "/usr/local/bin", "/opt/libreoffice/program", "/snap/bin"] {
      candidates.push(Path::new(dir).join("soffice"));
      candidates.push(Path::new(dir).join("libreoffice"));
    }
  }
  candidates.into_iter().find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn urls() {
    assert_eq!(file_url(Path::new("/tmp/a b")), "file:///tmp/a%20b");
    assert_eq!(file_url(Path::new(r"C:\Users\x")), "file:///C:/Users/x");
  }

  /// Round trip through the LibreOffice installed on this machine, when there is one.
  #[test]
  fn round_trip() {
    let Some(exe) = ["/usr/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"]
      .iter()
      .map(PathBuf::from)
      .find(|p| p.is_file())
    else {
      return;
    };
    let profile = tempdir().unwrap();
    let pdf = run(&exe, &profile, "note.txt", "pdf", b"Hello PX-4821").unwrap();
    assert!(pdf.starts_with(b"%PDF"));
    let docx = run(&exe, &profile, "note.pdf", "docx", &pdf).unwrap();
    assert!(docx.starts_with(b"PK"));
    assert!(run(&exe, &profile, "note.exe", "pdf", b"x").is_err());
    assert!(run(&exe, &profile, "note.docx", "docx", b"x").is_err());
    let _ = fs::remove_dir_all(profile);
  }
}
