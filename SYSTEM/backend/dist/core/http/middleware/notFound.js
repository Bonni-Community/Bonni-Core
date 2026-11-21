export function notFound(_req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({
        error: "NOT_FOUND",
        message: "Route not found"
    });
}
