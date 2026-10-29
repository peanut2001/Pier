use tauri::http::{Method, Request, Response, StatusCode};

// A document fetched from this protocol does not inherit the main webview's CSP.
// Allow inline page interactions while denying network APIs, external scripts,
// nested frames, forms and same-origin access, even if the document is replaced.
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

pub fn response(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let found = request.method() == Method::GET && request.uri().path() == "/index.html";
    Response::builder()
        .status(if found {
            StatusCode::OK
        } else {
            StatusCode::NOT_FOUND
        })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", CSP)
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .body(if found {
            include_bytes!("../../src/lib/html-preview.html").to_vec()
        } else {
            Vec::new()
        })
        .expect("static preview response headers are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_an_isolated_shell_on_all_desktop_protocol_urls() {
        for uri in [
            "pier-preview://localhost/index.html",
            "http://pier-preview.localhost/index.html",
        ] {
            let request = Request::builder().uri(uri).body(Vec::new()).unwrap();
            let response = response(&request);
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["Content-Security-Policy"], CSP);
            assert!(!CSP.contains("allow-same-origin"));
            assert_eq!(
                response.body(),
                include_bytes!("../../src/lib/html-preview.html")
            );
        }
    }

    #[test]
    fn cannot_serve_workspace_files_or_accept_writes() {
        for (method, uri) in [
            (Method::GET, "pier-preview://localhost/etc/passwd"),
            (Method::GET, "pier-preview://localhost/script.js"),
            (Method::POST, "pier-preview://localhost/index.html"),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(uri)
                .body(Vec::new())
                .unwrap();
            let response = response(&request);
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert!(response.body().is_empty());
        }
    }
}
