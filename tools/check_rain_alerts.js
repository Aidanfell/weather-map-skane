/* GitHub Actions Automated Rain Alert & Email Dispatcher
   Runs on a recurring 2-hour cron schedule.
   Checks Open-Meteo forecasts for subscribed locations and dispatches email alerts. */

const fs = require('fs');
const path = require('path');

const ALERTS_FILE = path.join(__dirname, '..', 'data', 'alerts.json');
const RESEND_API_KEY = process.env.RESEND_API_KEY;

function loadAlertSubscriptions() {
  if (!fs.existsSync(ALERTS_FILE)) {
    console.log('No alerts file found at:', ALERTS_FILE);
    return [];
  }
  try {
    const raw = fs.readFileSync(ALERTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse alerts file:', err);
    return [];
  }
}

async function fetchForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation,temperature_2m,cloud_cover,wind_speed_10m,wind_direction_10m&forecast_days=2&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

function buildEmailHtml(alert, incomingRain) {
  return `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #090d16; color: #f8fafc; padding: 24px; border-radius: 16px; border: 1px solid #1e293b;">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 20px; border-bottom: 1px solid #1e293b; padding-bottom: 16px;">
        <span style="font-size: 28px;">🌧️</span>
        <div>
          <h2 style="margin: 0; font-size: 20px; color: #38bdf8;">Rain Incoming for ${alert.locationName}</h2>
          <span style="font-size: 12px; color: #94a3b8;">Skåne & Blekinge High-Precision Radar Alert</span>
        </div>
      </div>
      
      <p style="font-size: 14px; color: #e2e8f0; line-height: 1.6;">
        Weather models predict incoming precipitation for your monitored location (<strong>${alert.locationName}</strong> at ${alert.lat}°N, ${alert.lon}°E).
      </p>

      <div style="background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 12px; padding: 16px; margin: 20px 0;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: #94a3b8;">Rain Arrival Time</div>
            <div style="font-size: 18px; font-weight: 700; color: #38bdf8;">${incomingRain.startTime}</div>
          </div>
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: #94a3b8;">Peak Rain Intensity</div>
            <div style="font-size: 18px; font-weight: 700; color: #f8fafc;">${incomingRain.maxRate.toFixed(1)} mm/h</div>
          </div>
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: #94a3b8;">Expected Temperature</div>
            <div style="font-size: 16px; font-weight: 600; color: #f8fafc;">${incomingRain.temp.toFixed(1)} °C</div>
          </div>
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: #94a3b8;">Wind Speed</div>
            <div style="font-size: 16px; font-weight: 600; color: #f8fafc;">${incomingRain.wind.toFixed(1)} m/s</div>
          </div>
        </div>
      </div>

      <div style="text-align: center; margin-top: 28px;">
        <a href="https://aidanfell.github.io/weather-map-skane/" style="background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: #ffffff; text-decoration: none; font-weight: 600; padding: 12px 24px; border-radius: 30px; display: inline-block;">
          Open Live Radar Map
        </a>
      </div>

      <div style="text-align: center; margin-top: 24px; border-top: 1px solid #1e293b; padding-top: 16px;">
        <span style="font-size: 11px; color: #64748b;">
          Don't want to receive rain notifications? <a href="https://aidanfell.github.io/weather-map-skane/?unsubscribe=${encodeURIComponent(alert.email)}" style="color: #38bdf8; text-decoration: underline;">Unsubscribe from Rain Alerts</a>
        </span>
      </div>
    </div>
  `;
}

async function sendEmailNotification(alert, incomingRain) {
  const subject = `🌧️ Rain Alert for ${alert.locationName}: Expected at ${incomingRain.startTime}`;
  const html = buildEmailHtml(alert, incomingRain);

  if (!RESEND_API_KEY) {
    console.log(`[DRY RUN - No RESEND_API_KEY set] Alert for ${alert.email} (${alert.locationName}): Rain ${incomingRain.maxRate} mm/h at ${incomingRain.startTime}`);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Skane Weather Radar <alerts@resend.dev>',
        to: [alert.email],
        subject,
        html,
      }),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}`);
    const data = await res.json();
    console.log(`✓ Email alert dispatched to ${alert.email} (ID: ${data.id})`);
  } catch (err) {
    console.error(`Failed to send email to ${alert.email}:`, err.message);
  }
}

async function processAlerts() {
  const alerts = loadAlertSubscriptions();
  console.log(`Loaded ${alerts.length} rain alert subscription(s).`);

  for (const alert of alerts) {
    try {
      console.log(`Checking forecast for ${alert.locationName} (${alert.lat}, ${alert.lon})...`);
      const forecast = await fetchForecast(alert.lat, alert.lon);
      const times = forecast.hourly.time;
      const precips = forecast.hourly.precipitation;
      const temps = forecast.hourly.temperature_2m;
      const winds = forecast.hourly.wind_speed_10m;

      // Look for incoming rain in the next 12 hours
      let incoming = null;
      for (let i = 0; i < Math.min(12, times.length); i++) {
        if (precips[i] >= alert.threshold) {
          if (!incoming) {
            const date = new Date(times[i]);
            incoming = {
              startTime: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + date.toLocaleDateString([], { weekday: 'short', day: 'numeric' }),
              maxRate: precips[i],
              temp: temps[i],
              wind: winds[i],
            };
          } else if (precips[i] > incoming.maxRate) {
            incoming.maxRate = precips[i];
          }
        }
      }

      if (incoming) {
        console.log(` -> RAIN DETECTED for ${alert.locationName}! Rate: ${incoming.maxRate} mm/h at ${incoming.startTime}`);
        await sendEmailNotification(alert, incoming);
      } else {
        console.log(` -> No rain exceeding threshold (${alert.threshold} mm/h) forecast in next 12h for ${alert.locationName}.`);
      }
    } catch (err) {
      console.error(`Error checking alert ${alert.id}:`, err.message);
    }
  }
}

processAlerts();
