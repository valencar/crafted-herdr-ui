import { describe, expect, it } from "vitest";
import type { ActionError } from "./bindings/ActionError";
import {
  addAdvice,
  addPseudoId,
  addProblems,
  addRequest,
  type AddFields,
} from "./addWorkbox";

const EMPTY: AddFields = {
  host: "",
  port: "",
  via: "",
  name: "",
  session: "",
  temporary: false,
};
const fields = (f: Partial<AddFields>): AddFields => ({ ...EMPTY, ...f });

const rpc = (code: string, message = "m", hint: string | null = null) =>
  ({
    kind: "core",
    error: { kind: "rpc", code, message, hint },
  }) as ActionError;

describe("addRequest", () => {
  it("trims_and_leaves_out_what_is_empty", () => {
    expect(
      addRequest(
        fields({
          host: " buildbox ",
          port: " 2222 ",
          name: "  ",
          temporary: true,
        }),
      ),
    ).toEqual({
      target: "buildbox",
      port: 2222,
      via: null,
      name: null,
      session: null,
      temporary: true,
    });
    expect(
      addRequest(
        fields({ via: " ssh dev@host ", name: "gpubox", session: "qa" }),
      ),
    ).toEqual({
      target: null,
      port: null,
      via: "ssh dev@host",
      name: "gpubox",
      session: "qa",
      temporary: false,
    });
  });
});

describe("addProblems", () => {
  it("a_host_or_a_custom_connection_is_needed_but_say_nothing_before_typing", () => {
    expect(addProblems(EMPTY)).toEqual({});
    expect(addProblems(fields({ host: "buildbox" }))).toEqual({});
  });

  it("mirrors_the_rust_checks", () => {
    expect(addProblems(fields({ host: "-oProxyCommand=x" })).host).toMatch(
      /can’t start with “-”/,
    );
    expect(addProblems(fields({ host: "bad host" })).host).toMatch(/letters/);
    expect(addProblems(fields({ host: "a", port: "0" })).port).toBeDefined();
    expect(
      addProblems(fields({ host: "a", port: "70000" })).port,
    ).toBeDefined();
    expect(addProblems(fields({ host: "a", port: "22x" })).port).toBeDefined();
    expect(addProblems(fields({ host: "a:22", port: "2222" })).port).toMatch(
      /already/,
    );
    expect(addProblems(fields({ host: "a", port: "2222" }))).toEqual({});
    // Names are machine names, like a terminal's.
    expect(addProblems(fields({ host: "a", name: "Build Box" })).name).toMatch(
      /a-z 0-9/,
    );
    expect(addProblems(fields({ host: "a", name: "t7" })).name).toMatch(
      /address/,
    );
    expect(addProblems(fields({ host: "a", name: "build-box" }))).toEqual({});
    for (const bad of ["-x", "a b", "a/b", "_x", "é", "a".repeat(65)]) {
      expect(
        addProblems(fields({ host: "a", session: bad })).session,
        bad,
      ).toBeDefined();
    }
    expect(
      addProblems(fields({ host: "a", session: "Work.2" })).session,
    ).toBeUndefined();
  });

  it("via_requires_name_and_refuses_a_backslash", () => {
    expect(addProblems(fields({ via: "ssh dev@host" })).name).toBe(
      "A custom connection needs a name.",
    );
    expect(addProblems(fields({ via: "ssh dev@host", name: "box" }))).toEqual(
      {},
    );
    for (const bad of ["ssh a\\b", "ssh a\tb", "-oX=y", "ssh a\u0000b"]) {
      expect(
        addProblems(fields({ via: bad, name: "box" })).via,
        JSON.stringify(bad),
      ).toBeDefined();
    }
    expect(
      addProblems(fields({ host: "buildbox", via: "ssh h", name: "box" })).via,
    ).toMatch(/not both/);
    expect(
      addProblems(fields({ via: "ssh h", name: "box", port: "22" })).port,
    ).toBeDefined();
  });
});

describe("addPseudoId", () => {
  it("covers_every_argument_so_a_changed_retry_is_a_different_tab", () => {
    const a = addRequest(fields({ host: "buildbox", port: "2222" }));
    expect(addPseudoId(a)).toBe("add:buildbox:2222");
    const ids = new Set([
      addPseudoId(a),
      addPseudoId({ ...a, name: "box" }),
      addPseudoId({ ...a, name: "other" }),
      addPseudoId({ ...a, session: "qa" }),
      addPseudoId({ ...a, temporary: true }),
      addPseudoId({ ...a, port: null }),
      addPseudoId({ ...a, target: "gpubox" }),
    ]);
    expect(ids.size).toBe(7);
    expect(
      addPseudoId({ ...a, name: "box", session: "qa", temporary: true }),
    ).toBe("add:buildbox:2222 --name box --session qa --temp");
    // The same request is the same tab.
    expect(addPseudoId({ ...a })).toBe(addPseudoId(a));
    expect(
      addPseudoId(addRequest(fields({ via: "ssh h", name: "gpubox" }))),
    ).toBe("add:--via ssh h --name gpubox");
    // A machine id is 32 hex digits or `local`: none starts with `add:`.
    expect(addPseudoId(a).startsWith("add:")).toBe(true);
  });
});

describe("addAdvice", () => {
  it("hc_missing_and_incompatible_offer_install", () => {
    for (const code of ["hc_missing", "incompatible"]) {
      expect(addAdvice(rpc(code, "hc is not installed"))).toEqual({
        kind: "install",
        why: "hc is not installed",
      });
    }
  });

  it("needs_login_and_unreachable_offer_a_terminal", () => {
    // needs_login's hint is not shown: the sheet's buttons already run the command it names.
    expect(
      addAdvice(
        rpc("needs_login", "wants a login", "run `hc machine add --via x`"),
      ),
    ).toEqual({
      kind: "terminal",
      code: "needs_login",
      why: "wants a login",
      hint: null,
    });
    expect(
      addAdvice(
        rpc(
          "unreachable",
          "cannot reach it",
          "check that `h echo ok` prints ok",
        ),
      ),
    ).toEqual({
      kind: "terminal",
      code: "unreachable",
      why: "cannot reach it",
      hint: "check that `h echo ok` prints ok",
    });
  });

  it("name_taken_and_already_added_are_inline", () => {
    expect(
      addAdvice(
        rpc(
          "name_taken",
          '"box" is already a machine here',
          "pick another with --name",
        ),
      ),
    ).toEqual({
      kind: "inline",
      field: "name",
      text: '"box" is already a machine here. Pick another name.',
    });
    expect(
      addAdvice(rpc("already_added", "that core is already added as devbox")),
    ).toEqual({
      kind: "inline",
      field: "host",
      text: "That core is already added as devbox.",
    });
    // By the field the person used.
    expect(
      addAdvice(
        rpc("already_added", "that core is already added as devbox"),
        true,
      ),
    ).toEqual({
      kind: "inline",
      field: "via",
      text: "That core is already added as devbox.",
    });
  });

  it("anything_else_is_just_words", () => {
    expect(addAdvice(rpc("invalid_params", "bad name"))).toEqual({
      kind: "other",
      text: "bad name",
    });
    expect(
      addAdvice({ kind: "invalid", message: "Enter an SSH host." }),
    ).toEqual({ kind: "other", text: "Enter an SSH host." });
    expect(
      addAdvice({
        kind: "maybeApplied",
        argv: [],
        message: "May have been applied.",
      }),
    ).toEqual({ kind: "other", text: "May have been applied." });
  });
});
