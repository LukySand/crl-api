import { describe, expect, test } from "bun:test";
import { buildAuditData } from "./logger";

describe("buildAuditData", () => {
  test("el metadata del llamador no pisa audit_action", () => {
    const d = buildAuditData("update", { metadata: { audit_action: "delete", operacion: "x" } });
    expect(d.metadata.audit_action).toBe("update");
    expect(d.metadata.operacion).toBe("x");
  });

  test("conserva el resto de los campos y funciona sin data", () => {
    expect(buildAuditData("create", { requestUrl: "/a" }).requestUrl).toBe("/a");
    expect(buildAuditData("create").metadata).toEqual({ audit_action: "create" });
  });
});
