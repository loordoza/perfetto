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
  bssid: bigint;
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

    await this.addScanEventsTrack(ctx, group);
    await this.addRssiSliceTrack(ctx, group);
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
          rssi_with_next_ts AS (
            SELECT
              ts,
              EXTRACT_ARG(arg_set_id, 'parent_bssid') AS bssid,
              CAST(EXTRACT_ARG(arg_set_id, 'signal') / 100 AS INTEGER) AS signal_dbm,
              LEAD(ts, 1, (SELECT max(ts) FROM ftrace_event)) OVER (PARTITION BY EXTRACT_ARG(arg_set_id, 'parent_bssid') ORDER BY ts) AS next_ts
            FROM ftrace_event
            WHERE name = 'cfg80211_inform_bss_frame'
          )
        SELECT
          ROW_NUMBER() OVER (ORDER BY ts) AS id,
          ts,
          (next_ts - ts) AS dur,
          bssid,
          signal_dbm,
          printf(
            '%02X:%02X:%02X:%02X:%02X:%02X, %d dBm',
            (bssid >> 40) & 0xFF,
            (bssid >> 32) & 0xFF,
            (bssid >> 24) & 0xFF,
            (bssid >> 16) & 0xFF,
            (bssid >> 8) & 0xFF,
            bssid & 0xFF,
            signal_dbm
          ) AS name
        FROM
          rssi_with_next_ts
        WHERE
          (next_ts - ts) > 0
        ORDER BY ts
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
            bssid: LONG,
            signal_dbm: NUM,
            name: STR,
          },
        }),
        colorizer: (row) => {
          const signalDbm = (row as RssiDataRow).signal_dbm;
          if (signalDbm >= -19) {
            return makeColorScheme(new HSLColor({h: 120, s: 70, l: 40}));
          } else if (signalDbm >= -70) {
            return makeColorScheme(new HSLColor({h: 60, s: 70, l: 50}));
          } else {
            return makeColorScheme(new HSLColor({h: 0, s: 70, l: 50}));
          }
        },
        tooltip: (slice) => `
          RSSI:${(slice.row as RssiDataRow).signal_dbm} dBm
        `,
      }),
    });
    const trackNode = new TrackNode({uri, name});
    parent.addChildInOrder(trackNode);
  }
}
