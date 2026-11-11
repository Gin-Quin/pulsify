//! HTTP plumbing shared with the TypeScript gateway: errors, CORS, paths and queries.
use axum::body::Body;
use axum::http::{header, HeaderValue, Response, StatusCode};
use serde_json::{json, Value};

#[derive(Debug)]
pub struct CloudError {
    pub code: &'static str,
    pub message: String,
}
impl CloudError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn status(&self) -> StatusCode {
        match self.code {
            "BAD_REQUEST" => StatusCode::BAD_REQUEST,
            "UNAUTHORIZED" => StatusCode::UNAUTHORIZED,
            "FORBIDDEN" => StatusCode::FORBIDDEN,
            "NOT_FOUND" => StatusCode::NOT_FOUND,
            "METHOD_NOT_ALLOWED" => StatusCode::METHOD_NOT_ALLOWED,
            "UPGRADE_REQUIRED" => StatusCode::UPGRADE_REQUIRED,
            "LIMIT_EXCEEDED" => StatusCode::PAYLOAD_TOO_LARGE,
            _ => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
    pub fn response(&self) -> Response<Body> {
        json_response(
            self.status(),
            &json!({ "error": { "code": self.code, "message": self.message } }),
        )
    }
}

fn cors(response: &mut Response<Body>) {
    let headers = response.headers_mut();
    for (name, value) in [
        ("access-control-allow-origin", "*"),
        ("access-control-allow-methods", "GET, PUT, DELETE, OPTIONS"),
        (
            "access-control-allow-headers",
            "Authorization, Content-Type",
        ),
        ("access-control-max-age", "86400"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
}

pub fn json_response(status: StatusCode, body: &Value) -> Response<Body> {
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    cors(&mut response);
    response
}

pub fn preflight_response() -> Response<Body> {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    cors(&mut response);
    response
}

/// Strict percent-decoding; `plus_as_space` follows `URLSearchParams`.
pub fn percent_decode(value: &str, plus_as_space: bool) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
                decoded.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' if plus_as_space => {
                decoded.push(b' ');
                i += 1;
            }
            byte => {
                decoded.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(decoded).ok()
}

pub fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(key, true)? == name).then(|| percent_decode(value, true))?
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Connect,
    Grants,
    Usage,
}

/// `/v1/roots/{root}/{action}`, with the root percent-encoded as one segment.
pub fn parse_path(path: &str) -> Result<Option<(String, Action)>, CloudError> {
    let Some(rest) = path.strip_prefix("/v1/roots/") else {
        return Ok(None);
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let Some((segment, action)) = rest.split_once('/') else {
        return Ok(None);
    };
    let action = match action {
        "connect" => Action::Connect,
        "grants" => Action::Grants,
        "usage" => Action::Usage,
        _ => return Ok(None),
    };
    if segment.is_empty() {
        return Ok(None);
    }
    let root = percent_decode(segment, false)
        .filter(|root| crate::access::valid_root(root))
        .ok_or_else(|| CloudError::new("BAD_REQUEST", "Invalid root document ID"))?;
    Ok(Some((root, action)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_queries_decode_like_the_browser() {
        assert_eq!(
            parse_path("/v1/roots/%C3%A9quipe%201/grants").unwrap(),
            Some(("équipe 1".into(), Action::Grants))
        );
        assert!(parse_path("/v1/roots/a%2Fb/connect").is_err());
        assert_eq!(parse_path("/v1/roots/a/delete").unwrap(), None);
        assert_eq!(parse_path("/v1/roots/a/b/connect").unwrap(), None);
        assert_eq!(
            query_param(Some("subject=a+b&prefix=r%2Fx"), "prefix").as_deref(),
            Some("r/x")
        );
        assert_eq!(
            query_param(Some("subject=a+b"), "subject").as_deref(),
            Some("a b")
        );
    }
}
