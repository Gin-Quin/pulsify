//! Identity tokens (HS256 JWT) and the management API key.
use crate::http::CloudError;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

pub const TOKEN_AUDIENCE: &str = "pulsify-cloud";
pub const SUBPROTOCOL_E1: &str = "pulsify-cloud.1.e1";
pub const SUBPROTOCOL_E2: &str = "pulsify-cloud.1.e2";
pub const TOKEN_SUBPROTOCOL: &str = "pulsify-cloud.token.";
/// Socket liveness check, answered without touching the root.
pub const PING: &str = r#"{"type":"ping"}"#;
pub const PONG: &str = r#"{"type":"pong"}"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Caller {
    Admin,
    User(String),
}

pub struct Secrets {
    pub token_secret: String,
    pub api_key: String,
}

fn same_secret(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for (i, byte) in left.iter().enumerate() {
        difference |= usize::from(byte ^ right.get(i % right.len().max(1)).copied().unwrap_or(0));
    }
    difference == 0
}

/// The subject of a valid token for the cloud audience.
pub fn verify_token(token: &str, secret: &str) -> Option<String> {
    let mut parts = token.split('.');
    let (header, payload, signature) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).ok()?).ok()?;
    if header.get("alg")?.as_str()? != "HS256" {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(&token.as_bytes()[..token.rfind('.')?]);
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).ok()?)
        .ok()?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs_f64();
    if claims.get("exp")?.as_f64()? <= now {
        return None;
    }
    if let Some(nbf) = claims.get("nbf") {
        if nbf.as_f64()? > now {
            return None;
        }
    }
    let audience = match claims.get("aud")? {
        Value::String(audience) => audience == TOKEN_AUDIENCE,
        Value::Array(audiences) => audiences.iter().any(|a| a == TOKEN_AUDIENCE),
        _ => false,
    };
    let subject = claims.get("sub")?.as_str()?;
    if !audience || subject == crate::access::ANY_SUBJECT || !crate::access::valid_subject(subject)
    {
        return None;
    }
    Some(subject.to_owned())
}

/// The credential of a request: bearer header, token subprotocol, then `?token=`.
pub fn read_credential(
    authorization: Option<&str>,
    protocols: Option<&str>,
    query_token: Option<String>,
) -> Option<String> {
    if let Some(value) = authorization.and_then(|value| value.strip_prefix("Bearer ")) {
        let value = value.trim();
        return (!value.is_empty()).then(|| value.to_owned());
    }
    read_subprotocols(protocols)
        .1
        .or(query_token.filter(|token| !token.is_empty()))
}

/// The strongest offered envelope and the token subprotocol, if any.
pub fn read_subprotocols(header: Option<&str>) -> (Option<u8>, Option<String>) {
    let offered: Vec<&str> = header.unwrap_or("").split(',').map(str::trim).collect();
    let token = offered
        .iter()
        .find_map(|value| value.strip_prefix(TOKEN_SUBPROTOCOL))
        .filter(|token| !token.is_empty())
        .map(str::to_owned);
    let envelope = if offered.contains(&SUBPROTOCOL_E2) {
        Some(2)
    } else if offered.contains(&SUBPROTOCOL_E1) {
        Some(1)
    } else {
        None
    };
    (envelope, token)
}

/// `Ok(None)` without a credential; `UNAUTHORIZED` for a bad one.
pub fn authenticate(
    credential: Option<String>,
    secrets: &Secrets,
) -> Result<Option<Caller>, CloudError> {
    let Some(credential) = credential else {
        return Ok(None);
    };
    if secrets.api_key.len() >= 32 && same_secret(credential.as_bytes(), secrets.api_key.as_bytes())
    {
        return Ok(Some(Caller::Admin));
    }
    verify_token(&credential, &secrets.token_secret)
        .map(|subject| Some(Caller::User(subject)))
        .ok_or_else(|| CloudError::new("UNAUTHORIZED", "Invalid or expired token"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(claims: &str, secret: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(claims);
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{header}.{payload}").as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{header}.{payload}.{signature}")
    }

    #[test]
    fn tokens_need_signature_audience_and_expiry() {
        let secret = "a test token secret of at least 32 characters";
        let valid = sign(
            r#"{"sub":"u42","aud":"pulsify-cloud","exp":99999999999}"#,
            secret,
        );
        assert_eq!(verify_token(&valid, secret).as_deref(), Some("u42"));
        assert_eq!(verify_token(&valid, "another secret"), None);
        assert_eq!(
            verify_token(
                &sign(r#"{"sub":"u42","aud":"other","exp":99999999999}"#, secret),
                secret
            ),
            None
        );
        assert_eq!(
            verify_token(
                &sign(r#"{"sub":"u42","aud":"pulsify-cloud","exp":1}"#, secret),
                secret
            ),
            None
        );
        assert_eq!(
            verify_token(
                &sign(
                    r#"{"sub":"*","aud":"pulsify-cloud","exp":99999999999}"#,
                    secret
                ),
                secret
            ),
            None
        );
        assert_eq!(verify_token("junk", secret), None);
    }

    #[test]
    fn subprotocols_carry_the_envelope_and_token() {
        assert_eq!(
            read_subprotocols(Some(
                "pulsify-cloud.1.e1, pulsify-cloud.1.e2, pulsify-cloud.token.abc"
            )),
            (Some(2), Some("abc".into()))
        );
        assert_eq!(read_subprotocols(Some("chat")), (None, None));
    }
}
