// Pure mapping tests: parseItem + buildCreateInput. category/purpose are passed
// through RAW (no normalization), and the wizard feeds the SAME builder shape.

import { describe, expect, it } from "vitest";
import { buildCreateInput, parseItem } from "../../src/create-input.js";
import { UsageError } from "../../src/errors.js";

describe("parseItem", () => {
  it("treats a colon-free value as a catalog entry id (string)", () => {
    expect(parseItem("4b082452-5db4-4eb9-a2d4-6c906a9ceeb4")).toBe("4b082452-5db4-4eb9-a2d4-6c906a9ceeb4");
  });

  it("splits on the FIRST colon into a raw {category, purpose} pair", () => {
    expect(parseItem("Email Address:Marketing Outreach")).toEqual({
      category: "Email Address",
      purpose: "Marketing Outreach",
    });
  });

  it("preserves a purpose that itself contains a colon", () => {
    expect(parseItem("Cat:Pur:Extra")).toEqual({ category: "Cat", purpose: "Pur:Extra" });
  });

  it("does NOT normalize case/whitespace of the raw labels", () => {
    expect(parseItem("  Email Address :  Marketing  ")).toEqual({
      category: "  Email Address ",
      purpose: "  Marketing  ",
    });
  });

  it("rejects an empty category or purpose", () => {
    expect(() => parseItem(":Pur")).toThrow(UsageError);
    expect(() => parseItem("Cat:")).toThrow(UsageError);
  });
});

describe("buildCreateInput", () => {
  const ok = {
    customer: "cust-1",
    to: "ops@acme.example",
    document: "6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
    validUntil: "2030-01-01",
  };

  it("maps complete flags (--document) to a CreateConsentRequestInput", () => {
    expect(buildCreateInput(ok)).toEqual({
      customerId: "cust-1",
      recipientEmail: "ops@acme.example",
      consentDocumentId: "6a1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
      validUntil: "2030-01-01",
    });
  });

  it("maps --document-code to documentCode", () => {
    const rest = { customer: ok.customer, to: ok.to, validUntil: ok.validUntil };
    expect(buildCreateInput({ ...rest, documentCode: "conditions-marketing" })).toEqual({
      customerId: "cust-1",
      recipientEmail: "ops@acme.example",
      documentCode: "conditions-marketing",
      validUntil: "2030-01-01",
    });
  });

  it("requires --customer", () => {
    expect(() => buildCreateInput({ to: ok.to, document: ok.document, validUntil: ok.validUntil })).toThrow(/--customer/);
  });

  it("requires a valid --to email", () => {
    expect(() => buildCreateInput({ customer: ok.customer, document: ok.document, validUntil: ok.validUntil })).toThrow(/--to/);
    expect(() => buildCreateInput({ ...ok, to: "not-an-email" })).toThrow(/valid email/);
  });

  it("requires --valid-until in YYYY-MM-DD", () => {
    expect(() => buildCreateInput({ customer: ok.customer, to: ok.to, document: ok.document })).toThrow(/--valid-until/);
    expect(() => buildCreateInput({ ...ok, validUntil: "01/01/2030" })).toThrow(/YYYY-MM-DD/);
  });

  it("requires a --document or --document-code (a document-less issuance is refused locally)", () => {
    const rest = { customer: ok.customer, to: ok.to, validUntil: ok.validUntil };
    expect(() => buildCreateInput(rest)).toThrow(/--document/);
    expect(() => buildCreateInput({ ...rest, document: "  " })).toThrow(/--document/);
  });

  it("rejects passing BOTH --document and --document-code", () => {
    expect(() => buildCreateInput({ ...ok, documentCode: "terms" })).toThrow(/not both/);
  });
});
