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

    await this.addSliceTrack(
        ctx,
        group,
        'Scan Events',
        `
        SELECT
            s.ts,
            s.dur,
            'Scan' AS name,
            EXTRACT_ARG(s.arg_set_id, 'n_channels') AS n_channels,
            EXTRACT_ARG(s.arg_set_id, 'wdev_id') AS wdev_id,
            EXTRACT_ARG(s.arg_set_id, 'wiphy_mac') AS wiphy_mac,
            EXTRACT_ARG(s.arg_set_id, 'no_cck') AS no_cck,
            EXTRACT_ARG(s.arg_set_id, 'aborted') AS aborted,
            EXTRACT_ARG(s.arg_set_id, 'scan_start_tsf') AS scan_start_tsf,
            EXTRACT_ARG(s.arg_set_id, 'tsf_bssid') AS tsf_bssid
        FROM slice s
        WHERE s.name = 'cfg80211_scan_done'
        `
    );
  }

  async addSliceTrack(ctx: Trace, parent: TrackNode, name: string, sqlQuery: string) {
    const uri = `/wifi_${uuidv4()}`;
    const track = await createQuerySliceTrack({
      trace: ctx,
      uri,
      data: {
        sqlSource: sqlQuery,
        columns: [
          'ts',
          'dur',
          'name',
          'n_channels',
          'wdev_id',
          'wiphy_mac',
          'no_cck',
          'aborted',
          'scan_start_tsf',
          'tsf_bssid',
        ],
      },
      argColumns: [
          'n_channels',
          'wdev_id',
          'wiphy_mac',
          'no_cck',
          'aborted',
          'scan_start_tsf',
          'tsf_bssid',
      ],
    });
    ctx.tracks.registerTrack({uri, renderer: track});
    const trackNode = new TrackNode({uri, name});
    parent.addChildInOrder(trackNode);
  }
}