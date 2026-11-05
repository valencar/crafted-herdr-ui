use serde_json::Value;

use crate::terminal::quote::shell_quote;

/// The command line shown (and copied) for an RPC: the `hc` command when the call has a CLI
/// equivalent, else `hc rpc <method> <compact params>`. `bin_name` is the resolved binary's file
/// name. Every value goes through `shell_quote`.
pub fn display(method: &str, params: &Value, bin_name: &str) -> String {
    let mut words = vec![bin_name.to_owned()];
    match cli_words(method, params) {
        Some(rest) => words.extend(rest.into_iter().map(|w| shell_quote(&w))),
        None => {
            words.push("rpc".to_owned());
            words.push(shell_quote(method));
            words.push(shell_quote(&params.to_string()));
        }
    }
    words.join(" ")
}

fn text<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

/// The terminal a call is about, or an empty word so the line still reads.
fn terminal(params: &Value) -> String {
    text(params, "terminal").unwrap_or_default().to_owned()
}

fn strings(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A flag and its value, when the value is set.
fn flag(words: &mut Vec<String>, name: &str, value: Option<&str>) {
    if let Some(value) = value {
        words.push(name.to_owned());
        words.push(value.to_owned());
    }
}

/// The words after the binary name, unquoted, for a method that has a CLI equivalent.
fn cli_words(method: &str, params: &Value) -> Option<Vec<String>> {
    let words = |parts: &[&str]| parts.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>();
    Some(match method {
        "terminal.run" => {
            let mut w = words(&["run", "--bg"]);
            flag(&mut w, "--on", text(params, "on"));
            flag(&mut w, "--cwd", text(params, "cwd"));
            flag(&mut w, "--name", text(params, "name"));
            if params.get("keep").and_then(Value::as_bool) == Some(true) {
                w.push("--keep".to_owned());
            }
            w.extend(strings(params, "argv"));
            // A line is one argument, as it is quoted.
            w.extend(text(params, "line").map(str::to_owned));
            w
        }
        "terminal.label" => {
            let mut w = words(&["label"]);
            w.push(terminal(params));
            if let Some(labels) = params.get("labels").and_then(Value::as_object) {
                for (key, value) in labels {
                    // `key=` removes a label.
                    let value = match value {
                        Value::Null => String::new(),
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    w.push(format!("{key}={value}"));
                }
            }
            w
        }
        "terminal.send" => {
            let mut w = words(&["send"]);
            w.push(terminal(params));
            w.push(text(params, "text").unwrap_or_default().to_owned());
            w
        }
        "terminal.kill" => vec!["kill".to_owned(), terminal(params)],
        "terminal.rm" => vec!["rm".to_owned(), terminal(params)],
        "terminal.keep" => {
            let mut w = vec!["keep".to_owned(), terminal(params)];
            if params.get("keep").and_then(Value::as_bool) == Some(false) {
                w.push("--off".to_owned());
            }
            w
        }
        "terminal.interrupt" => vec!["interrupt".to_owned(), terminal(params)],
        "terminal.read" => vec!["read".to_owned(), terminal(params)],
        "machine.rename" => vec![
            "machine".to_owned(),
            "rename".to_owned(),
            text(params, "machine").unwrap_or_default().to_owned(),
            text(params, "new_name").unwrap_or_default().to_owned(),
        ],
        "machine.rm" => vec![
            "machine".to_owned(),
            "rm".to_owned(),
            text(params, "machine").unwrap_or_default().to_owned(),
        ],
        "machine.add" => {
            let mut w = words(&["machine", "add"]);
            w.extend(text(params, "target").map(str::to_owned));
            flag(&mut w, "--name", text(params, "name"));
            flag(&mut w, "--via", text(params, "via"));
            flag(&mut w, "--session", text(params, "session"));
            if params.get("temporary").and_then(Value::as_bool) == Some(true) {
                w.push("--temp".to_owned());
            }
            w
        }
        "machine.list" => words(&["machine", "ls"]),
        "templates.list" => words(&["templates"]),
        "machine.exec" => {
            let mut w = words(&["exec"]);
            flag(&mut w, "--on", text(params, "on"));
            w.push("--".to_owned());
            w.extend(strings(params, "argv"));
            w.extend(text(params, "line").map(str::to_owned));
            w
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn display_table() {
        let d = |method: &str, params: Value| display(method, &params, "hc");
        assert_eq!(
            d(
                "terminal.run",
                json!({"argv": ["claude"], "cwd": "/srv/app", "on": "buildbox"})
            ),
            "hc run --bg --on buildbox --cwd /srv/app claude"
        );
        assert_eq!(
            d("terminal.run", json!({"line": "npm test && echo done"})),
            "hc run --bg 'npm test && echo done'"
        );
        // A name and keep are part of the line; the app's own labels and env are not.
        assert_eq!(
            d(
                "terminal.run",
                json!({"argv": ["claude", "fix it"], "name": "orders", "keep": true,
                       "labels": {"herdr.seen": "0"}, "env": {"TERM": "xterm-256color"}})
            ),
            "hc run --bg --name orders --keep claude 'fix it'"
        );
        assert_eq!(
            d("terminal.run", json!({"keep": false, "cwd": "/srv/app"})),
            "hc run --bg --cwd /srv/app"
        );
        assert_eq!(
            d(
                "terminal.label",
                json!({"terminal": "buildbox/t7", "labels": {"herdr.seen": "4"}})
            ),
            "hc label buildbox/t7 herdr.seen=4"
        );
        assert_eq!(
            d(
                "terminal.send",
                json!({"terminal": "t7", "text": "yes please"})
            ),
            "hc send t7 'yes please'"
        );
        assert_eq!(d("terminal.kill", json!({"terminal": "t7"})), "hc kill t7");
        assert_eq!(d("terminal.rm", json!({"terminal": "t7"})), "hc rm t7");
        assert_eq!(
            d("terminal.keep", json!({"terminal": "t7", "keep": true})),
            "hc keep t7"
        );
        assert_eq!(
            d("terminal.keep", json!({"terminal": "t7", "keep": false})),
            "hc keep t7 --off"
        );
        assert_eq!(
            d("terminal.interrupt", json!({"terminal": "t7"})),
            "hc interrupt t7"
        );
        assert_eq!(d("terminal.read", json!({"terminal": "t7"})), "hc read t7");
        assert_eq!(
            d(
                "machine.rename",
                json!({"machine": "buildbox", "new_name": "gpubox"})
            ),
            "hc machine rename buildbox gpubox"
        );
        assert_eq!(
            d("machine.rm", json!({"machine": "buildbox"})),
            "hc machine rm buildbox"
        );
        assert_eq!(
            d(
                "machine.add",
                json!({"target": "dev@staging", "name": "staging", "session": "qa", "temporary": true})
            ),
            "hc machine add dev@staging --name staging --session qa --temp"
        );
        assert_eq!(
            d(
                "machine.add",
                json!({"via": "ssh jump gpubox", "name": "gpubox"})
            ),
            "hc machine add --name gpubox --via 'ssh jump gpubox'"
        );
        assert_eq!(d("machine.list", json!({})), "hc machine ls");
        assert_eq!(d("templates.list", json!({})), "hc templates");
        assert_eq!(
            d(
                "machine.exec",
                json!({"argv": ["sh", "-lc", "command -v claude"], "on": "buildbox"})
            ),
            "hc exec --on buildbox -- sh -lc 'command -v claude'"
        );
        assert_eq!(
            d("machine.exec", json!({"argv": ["uname"]})),
            "hc exec -- uname"
        );
        assert_eq!(
            d("doc.get", json!({"name": "herdr-app", "on": "buildbox"})),
            r#"hc rpc doc.get '{"name":"herdr-app","on":"buildbox"}'"#
        );
    }

    #[test]
    fn uses_the_resolved_binary_name_and_quotes_hostile_values() {
        assert_eq!(
            display("machine.list", &json!({}), "herdr-core"),
            "herdr-core machine ls"
        );
        assert_eq!(
            display("terminal.kill", &json!({"terminal": "t7; rm -rf /"}), "hc"),
            "hc kill 't7; rm -rf /'"
        );
        assert_eq!(
            display(
                "terminal.send",
                &json!({"terminal": "t7", "text": "it's"}),
                "hc"
            ),
            r"hc send t7 'it'\''s'"
        );
        assert_eq!(
            display(
                "terminal.label",
                &json!({"terminal": "t7", "labels": {"k": null}}),
                "hc"
            ),
            "hc label t7 k="
        );
    }
}
