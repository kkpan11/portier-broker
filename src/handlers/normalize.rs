use crate::email_address::EmailAddress;
use crate::utils::http::ResponseExt;
use crate::web::{data_response, Context, HandlerResult};
use headers::{CacheControl, ContentType};

/// Request handler for the email normalization endpoint.
///
/// Performs normalization of email addresses, for clients that cannot implement all the necessary
/// parts of the relevant specifications. (Unicode, WHATWG, etc.)
pub async fn normalize(ctx: &mut Context) -> HandlerResult {
    let result = String::from_utf8_lossy(&ctx.body)
        .lines()
        .map(|s| match s.parse::<EmailAddress>() {
            Ok(addr) => addr.to_string(),
            Err(_) => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut res = data_response(result);
    res.typed_header(ContentType::text_utf8());
    res.typed_header(CacheControl::new().with_no_cache().with_no_store());
    Ok(res)
}
