export function requireAuthenticated(req: any, res: any, next: any) {
  if (!req.user) {
    return res.status(401).json({
      code: "UNAUTHENTICATED",
      message: "Nicht angemeldet",
    });
  }

  return next();
}
