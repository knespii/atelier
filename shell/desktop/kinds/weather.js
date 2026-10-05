// The weather from GNOME Weather's location, as GNOME's calendar menu has
// it: now, and as a card the next hours too.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather?version=4.0';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DesktopWidget, label, launchApp} from '../widget.js';

const FORECASTS = 4;

export const WeatherWidget = GObject.registerClass(
class AtelierWeatherWidget extends DesktopWidget {
    build(box, size) {
        if (this._client === undefined) {
            this._client = Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient ?? null;
            this._client?.connectObject('changed', () => this._sync(), this);
            this._client?.update();
        }
        const now = new St.BoxLayout({style_class: 'atelier-widget-weather-now', x_expand: true});
        box.add_child(now);
        this._icon = new St.Icon({style_class: 'atelier-widget-weather-icon', y_align: Clutter.ActorAlign.CENTER});
        now.add_child(this._icon);
        this._temp = label('atelier-widget-temperature', '', {y_align: Clutter.ActorAlign.CENTER});
        now.add_child(this._temp);
        this._sky = label('atelier-widget-big-caption');
        this._sky.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._sky);
        this._place = label('atelier-widget-caption');
        this._place.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._place);
        this._hours = null;
        if (size === 'card') {
            this._hours = new St.BoxLayout({style_class: 'atelier-widget-forecast', x_expand: true, y_expand: true});
            box.add_child(this._hours);
        }
        this._sync();
    }

    _sync() {
        if (!this._icon)
            return;
        const client = this._client;
        const info = client?.info;
        if (!client?.available || !client.hasLocation || !info?.is_valid()) {
            this._icon.icon_name = 'weather-overcast-symbolic';
            this._temp.text = '';
            this._sky.text = client?.loading ? 'Loading the weather…' : 'No weather';
            this._place.text = client?.available && !client.hasLocation ? 'Pick a place in GNOME Weather' : '';
            this._hours?.destroy_all_children();
            return;
        }
        this._icon.icon_name = info.get_symbolic_icon_name();
        this._temp.text = info.get_temp_summary();
        this._sky.text = [info.get_conditions(), info.get_sky()].find(text => text && text !== '-') ?? '';
        this._place.text = info.get_location_name() ?? '';
        if (this._hours)
            this._syncHours(info);
    }

    _syncHours(info) {
        this._hours.destroy_all_children();
        const now = Date.now() / 1000;
        const coming = info.get_forecast_list().filter(forecast => {
            const [valid, time] = forecast.get_value_update();
            return valid && time > now;
        });
        // Every few hours, over the day ahead.
        const step = Math.max(1, Math.floor(coming.length / FORECASTS / 3));
        for (const forecast of coming.filter((_, i) => i % step === 0).slice(0, FORECASTS)) {
            const [, time] = forecast.get_value_update();
            const [, temp] = forecast.get_value_temp(GWeather.TemperatureUnit.DEFAULT);
            const column = new St.BoxLayout({
                style_class: 'atelier-widget-forecast-hour',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            column.add_child(label('atelier-widget-caption',
                formatTime(new Date(time * 1000), {timeOnly: true, ampm: false}).trim(), {x_align: Clutter.ActorAlign.CENTER}));
            column.add_child(new St.Icon({
                style_class: 'atelier-widget-forecast-icon',
                icon_name: forecast.get_symbolic_icon_name(),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            column.add_child(label('atelier-widget-agenda-text', `${Math.round(temp)}°`, {x_align: Clutter.ActorAlign.CENTER}));
            this._hours.add_child(column);
        }
    }

    activate() {
        launchApp('org.gnome.Weather.desktop');
    }

    cleanup() {
        this._client?.disconnectObject(this);
        this._client = null;
        this._icon = null;
    }
});
