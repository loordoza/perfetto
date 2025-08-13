// Copyright (C) 2023 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {uuidv4} from '../../base/uuid';
import {Trace} from '../../public/trace';
import {PerfettoPlugin} from '../../public/plugin';
import {createQuerySliceTrack} from '../../components/tracks/query_slice_track';
import {TrackNode} from '../../public/workspace';
import {makeColorScheme} from '../../components/colorizer';
import {HSLColor} from '../../base/color';
import {DatasetSliceTrack} from '../../components/tracks/dataset_slice_track';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, STR} from '../../trace_processor/query_result';

type RssiDataRow = {
  id: number;
  ts: bigint;
  dur: bigint;
  bssid_mac: string;
  signal_dbm: number;
  name: string;
};

export default class implements PerfettoPlugin {
  static readonly id = 'com.google.WifiInfo';

  async onTraceLoad(ctx: Trace): Promise<void> {
    const groupName = 'WiFi Scan Events';
    const group = new TrackNode({
      name: groupName,
      isSummary: true,
    });
    ctx.workspace.addChildInOrder(group);

    await this.addWifiEventsTrack(ctx, group);
    await this.addScanEventsTrack(ctx, group);
    await this.addRssiSliceTrack(ctx, group);
  }

  async addWifiEventsTrack(ctx: Trace, parent: TrackNode) {
    const uri = `/wifi_all_events_${uuidv4()}`;
    const sqlQuery = `
      SELECT
        ftrace_event.ts AS ts,
        0 AS dur,
        ftrace_event.name AS name,
        ftrace_event.utid AS utid,
        (
          SELECT json_group_array(
            json_object(
              key, 
              COALESCE(string_value, CAST(int_value AS TEXT), CAST(real_value AS TEXT))
            )
          ) FROM args WHERE args.arg_set_id = ftrace_event.arg_set_id
        ) AS args
      FROM ftrace_event
      WHERE 
        ftrace_event.name LIKE 'cfg80211_%' OR
        ftrace_event.name LIKE 'mac80211_%' OR
        ftrace_event.name LIKE 'rdev_%' OR
        ftrace_event.name LIKE 'drv_%' OR
        ftrace_event.name LIKE 'api_%' OR
        ftrace_event.name = 'skb_drop' OR
        ftrace_event.name = 'stop_queue' OR
        ftrace_event.name = 'wake_queue'
      ORDER BY ftrace_event.ts
    `;

    const track = await createQuerySliceTrack({
      trace: ctx,
      uri,
      data: {
        sqlSource: sqlQuery,
        columns: ['ts', 'dur', 'name', 'utid', 'args'],
      },
      argColumns: ['args'],
    });

    ctx.tracks.registerTrack({uri, renderer: track});
    const trackNode = new TrackNode({uri, name: 'All WiFi Events'});
    parent.addChildInOrder(trackNode);
  }

  async addScanEventsTrack(ctx: Trace, parent: TrackNode) {
    const uri = `/wifi_${uuidv4()}`;
    const sqlQuery = `
      WITH
        drv_hw_scan_events AS (
          SELECT
            ts,
            EXTRACT_ARG(arg_set_id, 'wiphy_name') as wiphy_name,
            EXTRACT_ARG(arg_set_id, 'vif_name') as vif_name,
            EXTRACT_ARG(arg_set_id, 'sdata') as sdata
          FROM ftrace_event
          WHERE name = 'drv_hw_scan'
        ),
        cfg80211_scan_done_events AS (
          SELECT
            ts,
            EXTRACT_ARG(arg_set_id, 'wiphy_mac') as wiphy_mac,
            EXTRACT_ARG(arg_set_id, 'aborted') as aborted
          FROM ftrace_event
          WHERE name = 'cfg80211_scan_done'
        )
      SELECT
        T1.ts,
        T2.ts - T1.ts AS dur,
        'WiFi Scan' AS name,
        T1.wiphy_name,
        T1.vif_name,
        T1.sdata,
        T2.wiphy_mac,
        T2.aborted
      FROM drv_hw_scan_events AS T1
      JOIN cfg80211_scan_done_events AS T2
      ON T1.ts < T2.ts
      AND T1.ts = (
        SELECT MAX(ts) FROM drv_hw_scan_events
        WHERE wiphy_name = T1.wiphy_name AND ts < T2.ts
      )
      ORDER BY T1.ts
    `;

    const track = await createQuerySliceTrack({
      trace: ctx,
      uri,
      data: {
        sqlSource: sqlQuery,
        columns: [
          'ts',
          'dur',
          'name',
          'wiphy_name',
          'vif_name',
          'sdata',
          'wiphy_mac',
          'aborted',
        ],
      },
      argColumns: ['wiphy_name', 'vif_name', 'sdata', 'wiphy_mac', 'aborted'],
    });
    ctx.tracks.registerTrack({uri, renderer: track});
    const trackNode = new TrackNode({uri, name: 'Scan Events'});
    parent.addChildInOrder(trackNode);
  }

  async addRssiSliceTrack(ctx: Trace, parent: TrackNode) {
    const name = 'Wi-Fi RSSI (dBm)';
    const uri = `/wifi_rssi_${uuidv4()}`;
    const sqlQuery = `
      WITH
      rssi_events AS (
        SELECT
          ts,
          EXTRACT_ARG(arg_set_id, 'parent_bssid') AS bssid,
          CAST(EXTRACT_ARG(arg_set_id, 'signal') / 100 AS INTEGER) AS signal_dbm
        FROM ftrace_event
        WHERE name = 'cfg80211_inform_bss_frame'
      ),
      scan_start_events AS (
        SELECT
          ts AS scan_start_ts
        FROM ftrace_event
        WHERE name = 'rdev_scan'
      ),
      scan_done_events AS (
        SELECT
          ts AS scan_done_ts
        FROM ftrace_event
        WHERE name = 'cfg80211_scan_done'
      ),
      last_scan_state AS (
        SELECT
          ts,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM scan_start_events
              WHERE scan_start_ts < ts
            ) AND (
              SELECT MAX(scan_start_ts)
              FROM scan_start_events
              WHERE scan_start_ts < ts
            ) > COALESCE(
              (SELECT MAX(scan_done_ts) FROM scan_done_events WHERE scan_done_ts < ts), 0
            )
            THEN 'true'
            ELSE 'false'
          END AS is_scanning
        FROM rssi_events
      ),
      rssi_with_dur AS (
        SELECT
          T1.ts,
          T1.bssid,
          T1.signal_dbm,
          T4.is_scanning,
          CASE T4.is_scanning
            WHEN 'true' THEN
              COALESCE(
                (
                  SELECT MIN(T5.ts)
                  FROM rssi_events T5
                  WHERE T5.ts > T1.ts AND T5.bssid = T1.bssid
                ),
                (
                  SELECT MIN(T6.scan_done_ts)
                  FROM scan_done_events T6
                  WHERE T6.scan_done_ts > (SELECT MIN(T7.scan_done_ts) FROM scan_done_events T7 WHERE T7.scan_done_ts > T1.ts)
                )
              ) - T1.ts
            ELSE
              COALESCE(
                (
                  SELECT MIN(T8.ts)
                  FROM rssi_events T8
                  WHERE T8.ts > T1.ts AND T8.bssid = T1.bssid
                ),
                (
                  SELECT MIN(T9.scan_done_ts)
                  FROM scan_done_events T9
                  WHERE T9.scan_done_ts > T1.ts
                )
              ) - T1.ts
          END AS dur
        FROM
          rssi_events T1
        LEFT JOIN
          last_scan_state T4 ON T1.ts = T4.ts
      )
      SELECT
        ROW_NUMBER() OVER (ORDER BY T1.ts) AS id,
        T1.ts,
        T1.dur,
        T1.signal_dbm,
        printf(
          '%02X:%02X:%02X:%02X:%02X:%02X',
          (T1.bssid >> 40) & 0xFF,
          (T1.bssid >> 32) & 0xFF,
          (T1.bssid >> 24) & 0xFF,
          (T1.bssid >> 16) & 0xFF,
          (T1.bssid >> 8) & 0xFF,
          T1.bssid & 0xFF
        ) AS bssid_mac,
        printf(
          '%02X:%02X:%02X:%02X:%02X:%02X, %d dBm',
          (T1.bssid >> 40) & 0xFF,
          (T1.bssid >> 32) & 0xFF,
          (T1.bssid >> 24) & 0xFF,
          (T1.bssid >> 16) & 0xFF,
          (T1.bssid >> 8) & 0xFF,
          T1.bssid & 0xFF,
          T1.signal_dbm
        ) AS name
      FROM
        rssi_with_dur T1
      ORDER BY
        T1.ts
    `;

    ctx.tracks.registerTrack({
      uri,
      renderer: new DatasetSliceTrack<RssiDataRow>({
        trace: ctx,
        uri,
        dataset: new SourceDataset<RssiDataRow>({
          src: sqlQuery,
          schema: {
            id: NUM,
            ts: LONG,
            dur: LONG,
            signal_dbm: NUM,
            bssid_mac: STR,
            name: STR,
          },
        }),
        colorizer: (row) => {
          const signalDbm = (row as RssiDataRow).signal_dbm;

          if (signalDbm >= -20) {
            return makeColorScheme(new HSLColor({h: 120, s: 70, l: 40}));
          } else if (signalDbm >= -70) {
            return makeColorScheme(new HSLColor({h: 60, s: 70, l: 50}));
          } else {
            return makeColorScheme(new HSLColor({h: 0, s: 70, l: 50}));
          }
        },
        tooltip: (slice) => `
          RSSI: ${(slice.row as RssiDataRow).signal_dbm} dBm
        `,
      }),
    });
    const trackNode = new TrackNode({uri, name});
    parent.addChildInOrder(trackNode);
  }
}
