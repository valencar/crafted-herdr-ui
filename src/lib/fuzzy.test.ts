import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches_a_subsequence_across_words", () => {
    expect(fuzzyScore("bb", "buildbox")).not.toBeNull();
  });

  it("ranks_a_prefix_above_a_match_inside_a_word", () => {
    const api = fuzzyScore("api", "api-service");
    const rapid = fuzzyScore("api", "rapid-api");
    expect(api).not.toBeNull();
    expect(rapid).not.toBeNull();
    expect(api as number).toBeGreaterThan(rapid as number);
  });

  it("does_not_match_characters_out_of_order", () => {
    expect(fuzzyScore("xb", "buildbox")).toBeNull();
    expect(fuzzyScore("ba", "ab")).toBeNull();
    expect(fuzzyScore("zzz", "buildbox")).toBeNull();
  });

  it("is_case_insensitive", () => {
    expect(fuzzyScore("BUILD", "buildbox")).toBe(
      fuzzyScore("build", "BuildBox"),
    );
    expect(fuzzyScore("build", "buildbox")).not.toBeNull();
  });

  it("scores_word_starts_and_consecutive_matches_higher", () => {
    // Word starts: w, a. Consecutive: "web" in "web-app".
    expect(fuzzyScore("wa", "web-app") as number).toBeGreaterThan(
      fuzzyScore("wa", "awkward") as number,
    );
    expect(fuzzyScore("web", "web-app") as number).toBeGreaterThan(
      fuzzyScore("web", "w-e-b") as number,
    );
  });

  it("prefers_the_shorter_text_on_a_tie", () => {
    expect(fuzzyScore("api", "api") as number).toBeGreaterThan(
      fuzzyScore("api", "api-service") as number,
    );
  });

  it("matches_everything_for_an_empty_query", () => {
    expect(fuzzyScore("", "anything")).not.toBeNull();
  });
});

describe("fuzzyMatch", () => {
  it("match_positions", () => {
    expect(fuzzyMatch("mig", "migrate-db")?.positions).toEqual([0, 1, 2]);
    expect(fuzzyMatch("md", "migrate-db")?.positions).toEqual([0, 8]);
  });

  it("is_null_when_nothing_matches_and_scores_like_fuzzy_score", () => {
    expect(fuzzyMatch("xb", "buildbox")).toBeNull();
    expect(fuzzyMatch("wa", "web-app")?.score).toBe(
      fuzzyScore("wa", "web-app"),
    );
    expect(fuzzyMatch("", "anything")?.positions).toEqual([]);
  });

  it("positions_are_code_point_indexes_into_the_original_text", () => {
    // The emoji is two UTF-16 units but one code point.
    expect(fuzzyMatch("api", "🔧 api-service")?.positions).toEqual([2, 3, 4]);
  });

  it("positions_survive_a_character_whose_lowercase_is_longer", () => {
    // "İ".toLowerCase() is two code points; "d" is still the second original character.
    expect(fuzzyMatch("d", "İd")?.positions).toEqual([1]);
    expect(fuzzyMatch("id", "İd")?.positions).toEqual([0, 1]);
  });
});
