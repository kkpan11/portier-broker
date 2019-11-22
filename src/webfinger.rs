use crate::config::ConfigRc;
use crate::email_address::EmailAddress;
use crate::error::BrokerError;
use crate::serde_helpers::UrlDef;
use crate::store_cache::{fetch_json_url, CacheKey};
use serde_derive::{Deserialize, Serialize};
use std::str::FromStr;
use url::Url;

/// Portier webfinger relation
pub const WEBFINGER_PORTIER_REL: &str = "https://portier.io/specs/auth/1.0/idp";
/// Portier + Google webfinger relation
pub const WEBFINGER_GOOGLE_REL: &str = "https://portier.io/specs/auth/1.0/idp/google";

/// Deserialization types
#[derive(Deserialize)]
pub struct DescriptorDef {
    #[serde(default)]
    pub links: Vec<LinkDef>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct LinkDef {
    #[serde(default)]
    pub rel: String,
    #[serde(default)]
    pub href: String,
}

/// Parsed and validated webfinger relation
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Relation {
    Portier,
    Google,
}

impl FromStr for Relation {
    type Err = &'static str;
    fn from_str(s: &str) -> Result<Relation, &'static str> {
        match s {
            WEBFINGER_PORTIER_REL => Ok(Relation::Portier),
            WEBFINGER_GOOGLE_REL => Ok(Relation::Google),
            _ => Err("unsupported value"),
        }
    }
}

/// Parsed and validated webfinger link
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub rel: Relation,
    #[serde(with = "UrlDef")]
    pub href: Url,
}

impl Link {
    /// Parse and validate a deserialized link
    pub fn from_de_link(link: &LinkDef) -> Result<Link, String> {
        match (link.rel.parse(), link.href.parse()) {
            (Ok(rel), Ok(href)) => Ok(Link { rel, href }),
            (Err(e), _) => Err(format!("invalid rel: {}", e)),
            (_, Err(e)) => Err(format!("invalid href: {}", e)),
        }
    }
}

/// Query webfinger for the given email address
///
/// This queries the webfinger endpoint of the domain for the given email
/// address. The resource queried is the email address itself, as an `acct` URL.
/// Request failures of any kind simply result in an empty list.
pub async fn query(app: &ConfigRc, email_addr: &EmailAddress) -> Result<Vec<Link>, BrokerError> {
    // Look for a configuration override.
    if let Some(mapped) = app.domain_overrides.get(email_addr.domain()) {
        return Ok(mapped.clone());
    }

    // Build the webfinger query URL. We can safely do string concatenation here, because the
    // domain has already been validated using the `url` crate.
    #[cfg(feature = "insecure")]
    let url = format!("http://{}/.well-known/webfinger", email_addr.domain());
    #[cfg(not(feature = "insecure"))]
    let url = format!("https://{}/.well-known/webfinger", email_addr.domain());

    let url = Url::parse_with_params(
        &url,
        &[
            ("resource", format!("acct:{}", email_addr).as_str()),
            ("rel", WEBFINGER_PORTIER_REL),
            ("rel", WEBFINGER_GOOGLE_REL),
        ],
    )
    .map_err(|e| BrokerError::Internal(format!("could not build webfinger query url: {}", e)))?;

    // Make the request.
    let descriptor: DescriptorDef = fetch_json_url(
        app,
        url,
        &CacheKey::Discovery {
            acct: email_addr.as_str(),
        },
    )
    .await?;

    // Parse the relations.
    let links = descriptor
        .links
        .iter()
        .filter_map(|link| Link::from_de_link(link).ok())
        // Sanity check: skip results that refer to ourselves.
        .filter(|link| link.href.as_str() != app.public_url)
        .collect();

    Ok(links)
}
