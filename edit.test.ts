import { describe, test, expect } from "bun:test";
import { parseAnalysisResponse, buildEditPrompt, buildEstimateMessage, type MacroEstimate } from "./analysis";

const SAMPLE: MacroEstimate = {
  description: "grilled chicken breast (~200g)",
  calories: 330,
  protein_g: 62,
  carbs_g: 0,
  fat_g: 7,
  fiber_g: 0,
  confidence: "high",
};

// ---------------------------------------------------------------------------
// parseAnalysisResponse
// ---------------------------------------------------------------------------

describe("parseAnalysisResponse", () => {
  test("valid JSON returns MacroEstimate", () => {
    const json = JSON.stringify(SAMPLE);
    const result = parseAnalysisResponse(json);
    expect(result).toEqual(SAMPLE);
  });

  test("JSON wrapped in markdown code block is extracted", () => {
    const json = "```json\n" + JSON.stringify(SAMPLE) + "\n```";
    const result = parseAnalysisResponse(json);
    expect(result).toEqual(SAMPLE);
  });

  test("JSON with surrounding prose is extracted", () => {
    const json = "Here is the estimate:\n" + JSON.stringify(SAMPLE) + "\nHope that helps!";
    const result = parseAnalysisResponse(json);
    expect(result).toEqual(SAMPLE);
  });

  test("error response returns null", () => {
    expect(parseAnalysisResponse('{"error": "No food detected"}')).toBeNull();
  });

  test("non-food error response returns null", () => {
    expect(parseAnalysisResponse('{"error": "Not food"}')).toBeNull();
  });

  test("completely invalid JSON returns null", () => {
    expect(parseAnalysisResponse("not json at all")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(parseAnalysisResponse("")).toBeNull();
  });

  test("notes field is preserved when present", () => {
    const withNotes = { ...SAMPLE, notes: "Estimated based on typical portion" };
    const result = parseAnalysisResponse(JSON.stringify(withNotes));
    expect(result?.notes).toBe("Estimated based on typical portion");
  });

  test("notes field absent when not in response", () => {
    const result = parseAnalysisResponse(JSON.stringify(SAMPLE));
    expect(result?.notes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildEditPrompt
// ---------------------------------------------------------------------------

describe("buildEditPrompt", () => {
  test("includes the original description", () => {
    const prompt = buildEditPrompt("plain cabbage (~100g)");
    expect(prompt).toContain("plain cabbage (~100g)");
  });

  test("prompts user to describe in plain English", () => {
    const prompt = buildEditPrompt("plain cabbage (~100g)");
    expect(prompt.toLowerCase()).toContain("plain english");
  });

  test("shows food description examples (not macro corrections)", () => {
    const prompt = buildEditPrompt("plain cabbage (~100g)");
    // Should contain food names, not "calories" / "protein" style corrections
    expect(prompt).not.toMatch(/calories \d+/i);
    expect(prompt).not.toMatch(/protein \d+g/i);
    expect(prompt).toContain("grilled chicken breast");
  });

  test("shows the Edit heading with original description", () => {
    const prompt = buildEditPrompt("bowl of ramen");
    expect(prompt).toContain("Editing");
    expect(prompt).toContain("bowl of ramen");
  });
});

// ---------------------------------------------------------------------------
// buildEstimateMessage
// ---------------------------------------------------------------------------

describe("buildEstimateMessage", () => {
  test("high confidence shows ✅", () => {
    expect(buildEstimateMessage({ ...SAMPLE, confidence: "high" })).toContain("✅");
  });

  test("medium confidence shows ⚠️", () => {
    expect(buildEstimateMessage({ ...SAMPLE, confidence: "medium" })).toContain("⚠️");
  });

  test("low confidence shows ❓", () => {
    expect(buildEstimateMessage({ ...SAMPLE, confidence: "low" })).toContain("❓");
  });

  test("includes all macro values", () => {
    const msg = buildEstimateMessage(SAMPLE);
    expect(msg).toContain("330 kcal");
    expect(msg).toContain("62g");  // protein
    expect(msg).toContain("0g");   // carbs
    expect(msg).toContain("7g");   // fat
  });

  test("includes description", () => {
    const msg = buildEstimateMessage(SAMPLE);
    expect(msg).toContain("grilled chicken breast (~200g)");
  });

  test("ends with 'Log this?'", () => {
    const msg = buildEstimateMessage(SAMPLE);
    expect(msg).toContain("Log this?");
  });

  test("note is included when present", () => {
    const msg = buildEstimateMessage({ ...SAMPLE, notes: "Rough estimate" });
    expect(msg).toContain("Rough estimate");
  });

  test("note is absent when not provided", () => {
    const msg = buildEstimateMessage(SAMPLE);
    expect(msg).not.toContain("Note:");
  });

  test("suffix is appended to description (edit re-analysis case)", () => {
    const msg = buildEstimateMessage(SAMPLE, " _(updated)_");
    expect(msg).toContain("_(updated)_");
  });

  test("no suffix by default", () => {
    const msg = buildEstimateMessage(SAMPLE);
    expect(msg).not.toContain("_(updated)_");
  });
});
