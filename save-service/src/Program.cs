using SaveService;

// Internal-only save parser (ADR-003, NFR-04). Stateless: bytes in, JSON out.
// Dev: TCP on :8080 (published to 127.0.0.1 only). Prod: set LISTEN_SOCKET and
// run with network_mode: none so the container has no network at all.
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(o =>
{
    o.Limits.MaxRequestBodySize = SaveLoader.MaxSaveBytes;
    var socket = Environment.GetEnvironmentVariable("LISTEN_SOCKET");
    if (!string.IsNullOrEmpty(socket))
    {
        if (File.Exists(socket)) File.Delete(socket);
        o.ListenUnixSocket(socket);
    }
});

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { ok = true, pkhex = SaveLoader.PkhexVersion }));

app.MapPost("/parse", async (HttpRequest req) =>
{
    var data = await ReadBody(req);
    if (data is null) return Results.BadRequest(new { ok = false, error = "bad_size" });
    var sav = SaveLoader.Load(data);
    return sav is null
        ? Results.UnprocessableEntity(new { ok = false, error = "unrecognised_save" })
        : Results.Ok(SaveSummary.From(sav));
});

app.MapPost("/legality", async (HttpRequest req, int box, int slot) =>
{
    var data = await ReadBody(req);
    if (data is null) return Results.BadRequest(new { ok = false, error = "bad_size" });
    var sav = SaveLoader.Load(data);
    if (sav is null) return Results.UnprocessableEntity(new { ok = false, error = "unrecognised_save" });
    var report = Legality.Check(sav, box, slot);
    return report is null
        ? Results.NotFound(new { ok = false, error = "empty_slot" })
        : Results.Ok(report);
});

// Phase 2: swap Box 1 Slot 1 between two saves, apply trade evolution, fix checksums.
app.MapPost("/trade", () => Results.Json(new { ok = false, error = "not_implemented" }, statusCode: 501));

app.Run();

static async Task<byte[]?> ReadBody(HttpRequest req)
{
    using var ms = new MemoryStream();
    await req.Body.CopyToAsync(ms);
    var bytes = ms.ToArray();
    return SaveLoader.IsAcceptedSize(bytes.Length) ? bytes : null;
}
