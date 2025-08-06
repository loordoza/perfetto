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
      argColumns: [
          'wiphy_name',
          'vif_name',
          'sdata',
          'wiphy_mac',
          'aborted',
      ],
      trackIdColumn: 'wiphy_name',
    });
    ctx.tracks.registerTrack({uri, renderer: track});
    const trackNode = new TrackNode({uri, name: 'Scan Events'});
    parent.addChildInOrder(trackNode);
  }
}