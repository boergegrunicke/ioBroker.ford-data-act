# Mapping Matrix (v1 Baseline)

Diese Matrix dokumentiert das aktuelle Mapping von eingehender Fahrzeug-Payload auf ioBroker-States.

## Fahrzeug-Identifikation

| Ziel-State-Basis | Quelle (in Reihenfolge) | Hinweis |
|---|---|---|
| vehicles.<vinId> | vin, vehicleIdentificationNumber, fallback: unknown | vinId wird fuer Objekt-ID normalisiert |

## Batterie

| Ziel-State | Quelle (in Reihenfolge) | Normalisierung |
|---|---|---|
| battery.soc | battery.soc, battery.stateOfCharge, charging.batteryLevel | normalizeSoc: 0..1 -> 0..100 %, 0..100 direkt |
| battery.range_km | battery.range_km, battery.rangeKm, charging.estimatedRange | Zahl erwartet |

## Status und Kilometerstand

| Ziel-State | Quelle (in Reihenfolge) | Normalisierung |
|---|---|---|
| status | status, chargingStatus | String trim |
| odometer | diagnostics.odometer, odometer, mileage | Zahl erwartet |

## Laden

| Ziel-State | Quelle (in Reihenfolge) | Normalisierung |
|---|---|---|
| charging.power_kw | charging.power_kw | Zahl erwartet |
| charging.isCharging | charging.isCharging, fallback: status == charging | Bool parser akzeptiert true/false, 1/0, on/off |

## Position

| Ziel-State | Quelle (in Reihenfolge) | Normalisierung |
|---|---|---|
| location.latitude | location.latitude, position.latitude | Zahl erwartet |
| location.longitude | location.longitude, position.longitude | Zahl erwartet |

## Klima und Tueren

| Ziel-State | Quelle (in Reihenfolge) | Normalisierung |
|---|---|---|
| climate.insideTempC | climate.insideTempC, climate.interiorTemperature | Zahl erwartet |
| doors.locked | doors.locked, security.doorsLocked | Bool parser akzeptiert locked/unlocked, yes/no |

## Diagnose

| Ziel-State | Quelle | Hinweis |
|---|---|---|
| rawJson | gesamtes Fahrzeugobjekt | JSON-stringifiziert |

## Betriebs-States

| Ziel-State | Bedeutung |
|---|---|
| info.connection | true bei erfolgreichem Polling-Zyklus |
| info.lastUpdate | Zeitstempel letzter erfolgreicher Zyklus |
| info.lastError | Letzter Fehlertext (leer bei Erfolg) |
| info.vehicleCount | Anzahl erkannter Fahrzeuge |
