using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using OfficeNetworkMonitor.Models;
using OfficeNetworkMonitor.Services;

namespace OfficeNetworkMonitor.Controllers;

[ApiController]
[Route("api/network")]
public sealed class NetworkController(
    IHostRepository repository,
    MonitoringService monitoringService,
    IOptions<MonitoringOptions> options) : ControllerBase
{
    private readonly MonitoringOptions _options = options.Value;

    [HttpGet("hosts")]
    public async Task<ActionResult<IReadOnlyList<HostStatus>>> GetHosts(CancellationToken cancellationToken) =>
        Ok(await repository.GetStatusesAsync(cancellationToken));

    [HttpGet("summary")]
    public async Task<ActionResult<DashboardSummary>> GetSummary(CancellationToken cancellationToken) =>
        Ok(StatusChangeDetector.CalculateSummary(await repository.GetStatusesAsync(cancellationToken)));

    [HttpGet("config")]
    public IActionResult GetPublicConfig() => Ok(new
    {
        network = $"{_options.NetworkPrefix}0/24",
        startIp = $"{_options.NetworkPrefix}{_options.StartHost}",
        endIp = $"{_options.NetworkPrefix}{_options.EndHost}",
        scanIntervalSeconds = _options.ScanIntervalSeconds
    });

    [HttpGet("hosts/{ipAddress}")]
    public async Task<ActionResult<HostStatus>> GetHost(string ipAddress, CancellationToken cancellationToken)
    {
        if (!_options.ContainsIp(ipAddress))
            return BadRequest(new { error = "IP address is outside the configured monitoring range." });
        var host = await repository.GetStatusAsync(ipAddress, cancellationToken);
        return host is null ? NotFound() : Ok(host);
    }

    [HttpGet("history/{ipAddress}")]
    public async Task<ActionResult<IReadOnlyList<ScanResult>>> GetHistory(
        string ipAddress,
        CancellationToken cancellationToken)
    {
        if (!_options.ContainsIp(ipAddress))
            return BadRequest(new { error = "IP address is outside the configured monitoring range." });
        if (await repository.GetStatusAsync(ipAddress, cancellationToken) is null)
            return NotFound();
        return Ok(await repository.GetHistoryAsync(ipAddress, DateTime.UtcNow.AddHours(-1), cancellationToken));
    }

    [HttpGet("events")]
    public async Task<ActionResult<IReadOnlyList<MonitorEventDto>>> GetEvents(
        [FromQuery] int count = 12,
        CancellationToken cancellationToken = default) =>
        Ok(await repository.GetEventsAsync(Math.Clamp(count, 1, 100), cancellationToken));

    [HttpPost("hosts")]
    public async Task<IActionResult> AddHost(
        [FromBody] HostConfigurationRequest request,
        CancellationToken cancellationToken)
    {
        if (!_options.ContainsIp(request.IpAddress))
            return BadRequest(new { error = "IP address is outside the configured monitoring range." });
        var host = await repository.AddHostAsync(
            request.IpAddress, request.DisplayName?.Trim(), request.DeviceType.Trim(), cancellationToken);
        if (host is null)
            return Conflict(new { error = "This IP address is already configured." });
        return CreatedAtAction(nameof(GetHost), new { ipAddress = host.IpAddress }, host);
    }

    [HttpPut("hosts/{ipAddress}")]
    public async Task<IActionResult> UpdateHost(
        string ipAddress,
        [FromBody] UpdateHostRequest request,
        CancellationToken cancellationToken)
    {
        if (!_options.ContainsIp(ipAddress))
            return BadRequest(new { error = "IP address is outside the configured monitoring range." });
        var updated = await repository.UpdateHostAsync(
            ipAddress, request.DisplayName?.Trim(), request.DeviceType.Trim(), request.Enabled, cancellationToken);
        return updated ? NoContent() : NotFound();
    }

    [HttpPost("scan")]
    [EnableRateLimiting("manual-scan")]
    public IActionResult Scan()
    {
        if (!monitoringService.QueueManualScan())
            return Conflict(new { error = "A scan is already running or queued." });
        return Accepted(new { message = "Manual scan queued." });
    }
}

public sealed class HostConfigurationRequest
{
    [Required, RegularExpression(@"^\d{1,3}(\.\d{1,3}){3}$")]
    public string IpAddress { get; init; } = string.Empty;

    [StringLength(80)]
    public string? DisplayName { get; init; }

    [Required, StringLength(40, MinimumLength = 1)]
    public string DeviceType { get; init; } = "Unknown";
}

public sealed class UpdateHostRequest
{
    [StringLength(80)]
    public string? DisplayName { get; init; }

    [Required, StringLength(40, MinimumLength = 1)]
    public string DeviceType { get; init; } = "Unknown";

    public bool Enabled { get; init; } = true;
}