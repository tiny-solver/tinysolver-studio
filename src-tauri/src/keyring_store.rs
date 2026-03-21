use keyring::Entry;

const SERVICE_NAME: &str = "codeg";

fn token_key(account_id: &str) -> String {
    format!("github-token:{}", account_id)
}

pub fn set_token(account_id: &str, token: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, &token_key(account_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("keyring set error: {e}"))
}

pub fn get_token(account_id: &str) -> Option<String> {
    let entry = Entry::new(SERVICE_NAME, &token_key(account_id)).ok()?;
    entry.get_password().ok()
}

pub fn delete_token(account_id: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, &token_key(account_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
}
