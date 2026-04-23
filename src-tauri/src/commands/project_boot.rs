use serde::Serialize;
use std::path::PathBuf;

use crate::app_error::AppCommandError;

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PackageManagerInfo {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
}

async fn detect_one(name: &str) -> PackageManagerInfo {
    let program = match name {
        "bun" => "bun",
        "pnpm" => "pnpm",
        "yarn" => "yarn",
        _ => "npm",
    };

    let result = crate::process::tokio_command(program)
        .arg("--version")
        .output()
        .await;

    match result {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            PackageManagerInfo {
                name: name.to_string(),
                installed: true,
                version: Some(version),
            }
        }
        _ => PackageManagerInfo {
            name: name.to_string(),
            installed: false,
            version: None,
        },
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn detect_package_manager(name: String) -> PackageManagerInfo {
    detect_one(&name).await
}

// ---------------------------------------------------------------------------
// Project creation
// ---------------------------------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_shadcn_project(
    project_name: String,
    template: String,
    preset_code: String,
    package_manager: String,
    target_dir: String,
) -> Result<String, AppCommandError> {
    let project_name = project_name.trim().to_string();
    let template = template.trim().to_string();
    let preset_code = preset_code.trim().to_string();
    let package_manager = package_manager.trim().to_string();
    let target_dir = target_dir.trim().to_string();

    if project_name.is_empty() {
        return Err(AppCommandError::invalid_input("Project name is required"));
    }
    if template.is_empty() {
        return Err(AppCommandError::invalid_input("Template is required"));
    }
    if target_dir.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Target directory is required",
        ));
    }

    let full_path = PathBuf::from(&target_dir).join(&project_name);
    let full_path_str = full_path.to_string_lossy().to_string();

    // Check if directory already exists and is non-empty
    if full_path.exists() {
        let is_empty = full_path
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            return Err(AppCommandError::already_exists(
                "Target directory already exists and is not empty",
            ));
        }
    }

    // Determine the command based on package manager
    let (program, prefix_args): (&str, Vec<&str>) = match package_manager.as_str() {
        "pnpm" => ("pnpm", vec!["dlx"]),
        "yarn" => ("yarn", vec!["dlx"]),
        "bun" => ("bunx", vec![]),
        _ => ("npx", vec![]),
    };

    let mut cmd = crate::process::tokio_command(program);
    cmd.args(&prefix_args);
    cmd.args([
        "shadcn@latest",
        "init",
        "-n",
        &project_name,
        "-t",
        &template,
        "-p",
        &preset_code,
        "-y",
    ]);
    cmd.current_dir(&target_dir);

    // Log the full command for debugging
    let cmd_display = format!(
        "{} {} shadcn@latest init -n {} -t {} -p {} -y (cwd={})",
        program,
        prefix_args.join(" "),
        project_name,
        template,
        preset_code,
        target_dir
    );
    eprintln!("[ProjectBoot] executing: {cmd_display}");

    let output = cmd.output().await.map_err(|e| {
        eprintln!("[ProjectBoot] spawn error: {e}");
        if e.kind() == std::io::ErrorKind::NotFound {
            AppCommandError::dependency_missing(format!(
                "{program} is not installed. Please install Node.js first."
            ))
        } else {
            AppCommandError::external_command(
                "Failed to execute project creation command",
                e.to_string(),
            )
        }
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    eprintln!(
        "[ProjectBoot] exit={} stdout_len={} stderr_len={}",
        output.status,
        stdout.len(),
        stderr.len()
    );
    if !stdout.is_empty() {
        eprintln!("[ProjectBoot] stdout: {stdout}");
    }
    if !stderr.is_empty() {
        eprintln!("[ProjectBoot] stderr: {stderr}");
    }

    if !output.status.success() {
        let mut detail = String::new();
        if !stderr.is_empty() {
            detail.push_str(&stderr);
        }
        if !stdout.is_empty() {
            if !detail.is_empty() {
                detail.push('\n');
            }
            detail.push_str(&stdout);
        }
        if detail.is_empty() {
            detail = format!("Command exited with status: {}", output.status);
        }
        return Err(AppCommandError::external_command(
            "Project creation command failed",
            detail,
        ));
    }

    Ok(full_path_str)
}
