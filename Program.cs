using System.IO;
using System.Reflection;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using OfficeNetworkMonitor.Data;
using OfficeNetworkMonitor.Hubs;
using OfficeNetworkMonitor.Models;
using OfficeNetworkMonitor.Services;

var builder = WebApplication.CreateBuilder(args);

var entryAssembly = typeof(Program).Assembly;

// Load embedded appsettings.json if available as fallback/defaults
using (var embeddedConfigStream = entryAssembly.GetManifestResourceStream("OfficeNetworkMonitor.appsettings.json"))
{
	if (embeddedConfigStream != null)
	{
		builder.Configuration.AddJsonStream(embeddedConfigStream);
	}
}

// Allow external appsettings.json next to executable to override defaults
var externalSettingsPath = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
if (File.Exists(externalSettingsPath))
{
	builder.Configuration.AddJsonFile(externalSettingsPath, optional: true, reloadOnChange: true);
}

// Support embedded wwwroot static files fallback
var manifestProvider = new ManifestEmbeddedFileProvider(entryAssembly, "wwwroot");
var physicalWebRoot = Path.Combine(builder.Environment.ContentRootPath, "wwwroot");
IFileProvider fileProvider = Directory.Exists(physicalWebRoot)
	? new CompositeFileProvider(new PhysicalFileProvider(physicalWebRoot), manifestProvider)
	: manifestProvider;

builder.Environment.WebRootFileProvider = fileProvider;

builder.Services.AddControllers();
builder.Services.AddSignalR();

var rawConnectionString = builder.Configuration.GetConnectionString("MonitorDatabase") ?? "Data Source=office-monitor.db";
var connectionStringBuilder = new SqliteConnectionStringBuilder(rawConnectionString);
if (!string.IsNullOrWhiteSpace(connectionStringBuilder.DataSource) && !Path.IsPathRooted(connectionStringBuilder.DataSource))
{
	connectionStringBuilder.DataSource = Path.Combine(AppContext.BaseDirectory, connectionStringBuilder.DataSource);
}

builder.Services.AddDbContext<MonitorDbContext>(options =>
	options.UseSqlite(connectionStringBuilder.ToString()));
builder.Services.AddOptions<MonitoringOptions>()
	.Bind(builder.Configuration.GetSection("Monitoring"))
	.Validate(options => options.IsValid(out _), "Monitoring configuration is invalid.")
	.ValidateOnStart();
builder.Services.AddScoped<IHostRepository, HostRepository>();
builder.Services.AddSingleton<NetworkScanner>();
builder.Services.AddSingleton<TcpHealthChecker>();
builder.Services.AddSingleton<MonitoringService>();
builder.Services.AddHostedService(services => services.GetRequiredService<MonitoringService>());
builder.Services.AddRateLimiter(limiter =>
{
	var cooldownSeconds = builder.Configuration.GetValue<int>("Monitoring:ManualScanCooldownSeconds", 30);
	limiter.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
	limiter.AddPolicy("manual-scan", context => RateLimitPartition.GetFixedWindowLimiter(
		context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
		_ => new FixedWindowRateLimiterOptions
		{
			PermitLimit = 1,
			Window = TimeSpan.FromSeconds(Math.Max(1, cooldownSeconds)),
			QueueLimit = 0,
			AutoReplenishment = true
		}));
});

var app = builder.Build();
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });
app.UseStaticFiles(new StaticFileOptions { FileProvider = fileProvider });
app.UseRouting();
app.UseRateLimiter();
app.MapControllers();
app.MapHub<MonitorHub>("/monitorHub");

try
{
	await using var scope = app.Services.CreateAsyncScope();
	await scope.ServiceProvider.GetRequiredService<MonitorDbContext>().Database.EnsureCreatedAsync();
}
catch (Exception exception)
{
	app.Logger.LogError(exception, "Could not initialize the monitoring database");
}

app.Run();

public partial class Program;
