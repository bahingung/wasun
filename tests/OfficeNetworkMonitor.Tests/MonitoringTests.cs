using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Options;
using OfficeNetworkMonitor.Models;
using OfficeNetworkMonitor.Services;

namespace OfficeNetworkMonitor.Tests;

public sealed class MonitoringTests
{
    [Fact]
    public void GenerateIpAddresses_UsesConfiguredInclusiveRange()
    {
        var options = new MonitoringOptions { NetworkPrefix = "10.130.50.", StartHost = 2, EndHost = 4 };

        Assert.Equal(["10.130.50.2", "10.130.50.3", "10.130.50.4"], options.GenerateIpAddresses());
    }

    [Fact]
    public void ContainsIp_RejectsAddressesOutsideConfiguredRange()
    {
        var options = new MonitoringOptions { StartHost = 10, EndHost = 20 };

        Assert.True(options.ContainsIp("10.130.50.12"));
        Assert.False(options.ContainsIp("10.130.51.12"));
        Assert.False(options.ContainsIp("10.130.50.21"));
        Assert.False(options.ContainsIp("not-an-ip"));
    }

    [Fact]
    public void IsValid_RejectsInvalidConcurrencyAndPorts()
    {
        var invalidConcurrency = new MonitoringOptions { MaxConcurrency = 0 };
        var invalidPort = new MonitoringOptions { TcpPorts = [80, 65536] };

        Assert.False(invalidConcurrency.IsValid(out _));
        Assert.False(invalidPort.IsValid(out _));
        Assert.True(new MonitoringOptions().IsValid(out _));
    }

    [Fact]
    public async Task CheckAsync_ReportsDuplicateTcpPortsOnlyOnce()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var checker = new TcpHealthChecker(Options.Create(new MonitoringOptions { TcpPorts = [port, port] }));

        var status = await checker.CheckAsync("127.0.0.1", CancellationToken.None);

        Assert.Equal($"{port} OPEN", status);
    }

    [Fact]
    public void CalculateSummary_UsesOnlineHostsForAverageLatency()
    {
        var hosts = new[]
        {
            new HostStatus { IpAddress = "10.130.50.1", Online = true, LatencyMs = 8 },
            new HostStatus { IpAddress = "10.130.50.2", Online = true, LatencyMs = 12 },
            new HostStatus { IpAddress = "10.130.50.3", Online = false, LatencyMs = 0 }
        };

        var summary = StatusChangeDetector.CalculateSummary(hosts);

        Assert.Equal(3, summary.Total);
        Assert.Equal(2, summary.Online);
        Assert.Equal(1, summary.Offline);
        Assert.Equal(10, summary.AverageLatency);
    }

    [Theory]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, true, false)]
    public void HasChanged_DetectsOnlineStateTransitions(bool previous, bool current, bool expected)
    {
        Assert.Equal(expected, StatusChangeDetector.HasChanged(previous, current));
    }

    [Fact]
    public void HasChanged_DoesNotTreatFirstObservationAsTransition()
    {
        Assert.False(StatusChangeDetector.HasChanged(null, true));
        Assert.False(StatusChangeDetector.HasChanged(null, false));
    }
}