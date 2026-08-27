const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function emergencyReadOnlyMethodGuard(req, res, next) {
  if (SAFE_METHODS.has(String(req.method || "").toUpperCase())) {
    next();
    return;
  }
  res.status(405).json({
    ok: false,
    error: "EMERGENCY_BACKEND_READ_ONLY",
    message: "Das Emergency-Backend ist ausschließlich lesend. Schreibende Aktionen benötigen den bestätigten Active.",
  });
}
