//! Roots, grants and roles: the same rules as `pulsify-cloud`.
use serde::Serialize;
use std::cmp::Ordering;

pub const ANY_SUBJECT: &str = "*";
pub const MAX_GRANTS_PER_ROOT: usize = 10_000;
const MAX_ID_LENGTH: usize = 1024;
const MAX_SUBJECT_LENGTH: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Reader = 1,
    Editor = 2,
    Owner = 3,
}
impl Role {
    pub fn parse(value: &str) -> Option<Role> {
        match value {
            "reader" => Some(Role::Reader),
            "editor" => Some(Role::Editor),
            "owner" => Some(Role::Owner),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Reader => "reader",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }
    pub fn can_write(self) -> bool {
        self >= Role::Editor
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Grant {
    pub subject: String,
    pub prefix: String,
    pub role: Role,
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Everything before the first `/`.
pub fn root_of(doc_id: &str) -> &str {
    doc_id.split('/').next().unwrap_or(doc_id)
}

/// `"u1/notes"` covers itself and `"u1/notes/…"`, never `"u1/notes2"`.
pub fn covers(prefix: &str, doc_id: &str) -> bool {
    doc_id == prefix
        || (doc_id.len() > prefix.len()
            && doc_id.starts_with(prefix)
            && doc_id.as_bytes()[prefix.len()] == b'/')
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && utf16_len(id) <= MAX_ID_LENGTH && !id.contains('\0')
}
pub fn valid_root(root: &str) -> bool {
    valid_id(root) && !root.contains('/')
}
pub fn valid_document_of(root: &str, doc_id: &str) -> bool {
    valid_id(doc_id) && root_of(doc_id) == root && !doc_id.ends_with('/')
}
pub fn valid_subject(subject: &str) -> bool {
    !subject.is_empty() && utf16_len(subject) <= MAX_SUBJECT_LENGTH && !subject.contains('\0')
}

/// The strongest role granted to `subject` (or to everyone) on `doc_id` or an ancestor.
pub fn role_for<'a>(
    grants: impl IntoIterator<Item = &'a Grant>,
    subject: &str,
    doc_id: &str,
) -> Option<Role> {
    grants
        .into_iter()
        .filter(|grant| {
            (grant.subject == subject || grant.subject == ANY_SUBJECT)
                && covers(&grant.prefix, doc_id)
        })
        .map(|grant| grant.role)
        .max()
}

/// JavaScript string order (UTF-16 code units), so every backend lists grants alike.
pub fn compare_grants(a: &Grant, b: &Grant) -> Ordering {
    a.prefix
        .encode_utf16()
        .cmp(b.prefix.encode_utf16())
        .then_with(|| a.subject.encode_utf16().cmp(b.subject.encode_utf16()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(subject: &str, prefix: &str, role: Role) -> Grant {
        Grant {
            subject: subject.into(),
            prefix: prefix.into(),
            role,
        }
    }

    #[test]
    fn roles_follow_prefixes_and_the_strongest_grant() {
        let grants = [
            grant("bob", "u1", Role::Reader),
            grant("bob", "u1/notes/a", Role::Editor),
            grant("*", "u1/public", Role::Reader),
        ];
        assert_eq!(role_for(&grants, "bob", "u1"), Some(Role::Reader));
        assert_eq!(role_for(&grants, "bob", "u1/notes/a/b"), Some(Role::Editor));
        assert_eq!(
            role_for(&grants, "carol", "u1/public/x"),
            Some(Role::Reader)
        );
        assert_eq!(role_for(&grants, "carol", "u1"), None);
        assert!(!covers("u1/notes", "u1/notes2"));
        assert_eq!(root_of("u1/notes/a"), "u1");
    }

    #[test]
    fn identifiers_are_validated_like_javascript() {
        assert!(valid_root("équipe"));
        assert!(!valid_root("a/b"));
        assert!(valid_document_of("u1", "u1/x"));
        assert!(!valid_document_of("u1", "u2/x"));
        assert!(!valid_document_of("u1", "u1/"));
        assert!(valid_subject(&"🌍".repeat(128)));
        assert!(!valid_subject(&"🌍".repeat(129)));
    }
}
