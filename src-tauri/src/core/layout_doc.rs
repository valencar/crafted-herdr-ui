//! Reads herdr-app's layout document (`doc.get herdr-app`), read-only (spec §8.6).
//!
//! herdr-app keeps `{"spaces":[{"id","name","folder","tabs":[{"id","name","root":<node>}]}]}` in
//! the document of each machine (`src/mirror.rs`, `src/layout.rs` upstream). The format is private
//! to herdr-app and may change, so this parser is tolerant: it walks the JSON as it comes, takes
//! only what it recognises, and gives `None` when the document isn't the shape it knows. The app
//! never writes the document.
//!
//! What counts as a terminal (upstream `layout.rs`: `Kind` is tagged by `type`, `Content` is
//! untagged):
//! - the `content.terminal` string of a node whose `type` is `"block"`;
//! - the `content.terminal` of each entry of a node's `floating` list (a `Float` has a
//!   `content`, no `type`).
//!
//! `children` are walked on any node, in order, then `floating`. A mod block's `content.props`
//! can have a `terminal` key of its own; `props` is never read, so that is not a terminal leaf.
//! Addresses in a machine's document are bare and local to that machine (`t7`).

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::state::{SpaceLayout, SpacePlace};

/// The name of the document herdr-app keeps its spaces in, on each machine.
pub const LAYOUT_DOC: &str = "herdr-app";

/// The layout of one machine, or `None` when `value` is not a herdr-app layout document (not an
/// object, or no `spaces` array). Unknown fields are accepted. A terminal in two places keeps its
/// first one.
pub fn parse(value: &Value) -> Option<SpaceLayout> {
    let spaces = value.as_object()?.get("spaces")?.as_array()?;
    let mut by_address = BTreeMap::new();
    for (index, space) in spaces.iter().enumerate() {
        let Some(space) = space.as_object() else {
            continue;
        };
        let space_id = text(space, "id").unwrap_or_else(|| format!("space-{}", index + 1));
        let space_name = text(space, "name").unwrap_or_default();
        let space_folder = text(space, "folder").unwrap_or_default();
        let mut first = true;
        for tab in space
            .get("tabs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(tab) = tab.as_object() else {
                continue;
            };
            let tab_name = text(tab, "name").unwrap_or_default();
            let mut terminals = Vec::new();
            if let Some(root) = tab.get("root") {
                collect(root, &mut terminals);
            }
            for address in terminals {
                by_address.entry(address).or_insert_with(|| {
                    // The first terminal that finds a place in the space, in document order.
                    let first_in_space = std::mem::take(&mut first);
                    SpacePlace {
                        space_id: space_id.to_owned(),
                        space_name: space_name.to_owned(),
                        space_folder: space_folder.to_owned(),
                        tab_name: tab_name.to_owned(),
                        first_in_space,
                    }
                });
            }
        }
    }
    Some(SpaceLayout { by_address })
}

fn text(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key)?.as_str().map(str::to_owned)
}

/// The terminals under `node`, in document order.
fn collect(node: &Value, out: &mut Vec<String>) {
    let Some(node) = node.as_object() else {
        return;
    };
    if node.get("type").and_then(Value::as_str) == Some("block") {
        push_terminal(node.get("content"), out);
    }
    for child in node
        .get("children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        collect(child, out);
    }
    for float in node
        .get("floating")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        push_terminal(float.get("content"), out);
    }
}

/// `content.terminal`, when it is a non-empty string. Nothing else of `content` is read.
fn push_terminal(content: Option<&Value>, out: &mut Vec<String>) {
    if let Some(address) = content
        .and_then(|c| c.get("terminal"))
        .and_then(Value::as_str)
        .filter(|a| !a.is_empty())
    {
        out.push(address.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fixture() -> Value {
        let doc: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/hc/doc_herdr_app.json"))
                .unwrap();
        doc["value"].clone()
    }

    fn place(space: &str, name: &str, folder: &str, tab: &str, first: bool) -> SpacePlace {
        SpacePlace {
            space_id: space.into(),
            space_name: name.into(),
            space_folder: folder.into(),
            tab_name: tab.into(),
            first_in_space: first,
        }
    }

    #[test]
    fn parses_fixture_doc() {
        let layout = parse(&fixture()).unwrap();
        let api = |tab: &str, first: bool| {
            place("s1", "api-service", "/home/dev/api-service", tab, first)
        };
        let infra = |first: bool| place("s2", "", "/home/dev/infra", "", first);
        let expected: BTreeMap<String, SpacePlace> = [
            ("t1", api("main", true)),
            ("t2", api("main", false)),
            ("t5", api("main", false)),
            ("t7", api("main", false)),
            ("t8", api("tests", false)),
            ("t3", infra(true)),
            ("t6", infra(false)),
        ]
        .into_iter()
        .map(|(address, place)| (address.to_owned(), place))
        .collect();
        assert_eq!(layout.by_address, expected);
        // The mod block's props.terminal is not a terminal.
        assert!(!layout.by_address.contains_key("t4"));
    }

    #[test]
    fn walks_nested_and_floating_terminals() {
        let doc = json!({"spaces": [{"id": "s", "name": "n", "folder": "/f", "tabs": [{
        "id": "a", "name": "tab", "root": {
            "type": "column",
            "children": [
                {"type": "row", "children": [
                    {"type": "stack", "children": [
                        {"type": "block", "content": {"terminal": "t3"}}
                    ]},
                    {"type": "block", "content": {"terminal": "t4"},
                     "floating": [{"id": "f1", "content": {"terminal": "t5"}}]}
                ]}
            ],
            "floating": [{"id": "f2", "edge": "left", "content": {"terminal": "t6"}}]
        }}]}]});
        let layout = parse(&doc).unwrap();
        let addresses: Vec<&str> = layout.by_address.keys().map(String::as_str).collect();
        assert_eq!(addresses, ["t3", "t4", "t5", "t6"]);
        // Document order: t3 comes first, even though t6 sorts after it either way.
        let firsts: Vec<&str> = layout
            .by_address
            .iter()
            .filter(|(_, p)| p.first_in_space)
            .map(|(a, _)| a.as_str())
            .collect();
        assert_eq!(firsts, ["t3"]);
    }

    #[test]
    fn first_in_space_is_the_first_in_document_order_not_in_address_order() {
        let doc = json!({"spaces": [
            {"id": "s1", "tabs": [{"root": {"type": "row", "children": [
                {"type": "block", "content": {"terminal": "t9"}},
                {"type": "block", "content": {"terminal": "t2"}}]}}]},
            {"id": "s2", "tabs": [{"root": {"type": "block", "content": {"terminal": "t1"}}}]}
        ]});
        let layout = parse(&doc).unwrap();
        assert!(layout.by_address["t9"].first_in_space);
        assert!(!layout.by_address["t2"].first_in_space);
        assert!(layout.by_address["t1"].first_in_space);
    }

    #[test]
    fn ignores_mod_props_terminal() {
        let doc = json!({"spaces": [{"id": "s", "tabs": [{"id": "a", "root": {
            "type": "row", "children": [
                {"type": "block", "content": {"mod": "agents", "props": {"terminal": "t4"}}},
                {"type": "block", "content": {"mod": "x", "props": {"nested": {"terminal": "t8"}}}},
                {"type": "block", "content": {"terminal": "t1"}}
            ],
            "floating": [{"id": "f", "content": {"mod": "m", "props": {"terminal": "t5"}}}]
        }}]}]});
        let layout = parse(&doc).unwrap();
        assert_eq!(layout.by_address.keys().collect::<Vec<_>>(), ["t1"]);
        // A terminal key on a node that is not a block (or on its props) is not read either.
        let odd = json!({"spaces": [{"id": "s", "tabs": [{"root": {
            "type": "row", "content": {"terminal": "t2"}, "props": {"terminal": "t3"},
            "children": []}}]}]});
        assert!(parse(&odd).unwrap().by_address.is_empty());
    }

    #[test]
    fn ignores_unknown_fields() {
        let doc = json!({"version": 7, "future": [1, 2], "spaces": [{
        "id": "s", "name": "n", "folder": "/f", "color": "red", "tabs": [{
        "id": "a", "name": "t", "zoomed": "b1", "root": {
            "type": "block", "id": "b1", "size": {"weight": 3}, "hidden": true,
            "title": "x", "background": "#fff", "content": {"terminal": "t1", "extra": 1}
        }}]}]});
        let layout = parse(&doc).unwrap();
        assert_eq!(layout.by_address["t1"], place("s", "n", "/f", "t", true));
    }

    #[test]
    fn missing_pieces_get_defaults() {
        let doc = json!({"spaces": [
            {"tabs": [{"root": {"type": "block", "content": {"terminal": "t1"}}}]},
            {"id": 5, "name": 3, "tabs": "no"},
            "junk"
        ]});
        let layout = parse(&doc).unwrap();
        assert_eq!(layout.by_address["t1"], place("space-1", "", "", "", true));
        assert_eq!(layout.by_address.len(), 1);
    }

    #[test]
    fn none_for_garbage() {
        for value in [
            Value::Null,
            json!("spaces"),
            json!(3),
            json!([]),
            json!({}),
            json!({"spaces": {}}),
            json!({"spaces": "x"}),
            json!({"layout": {"spaces": []}}),
        ] {
            assert_eq!(parse(&value), None, "{value}");
        }
        // An empty list is a layout with nothing in it.
        assert_eq!(parse(&json!({"spaces": []})), Some(SpaceLayout::default()));
    }
}
