import AppLink from "../AppLink/AppLink";
import React, { FunctionComponent, ReactElement } from "react";
import RouteMap, { RouteUtil } from "../../Utils/RouteMap";
import PageMap from "../../Utils/PageMap";
import toHexId from "Common/UI/Utils/Telemetry/TraceIdHex";

export interface ComponentProps {
  traceId?: string | undefined;
}

const TraceElement: FunctionComponent<ComponentProps> = (
  props: ComponentProps,
): ReactElement => {
  const traceIdHex: string = toHexId(props.traceId);
  return (
    <div className="flex space-x-2">
      {traceIdHex ? (
        <div className={`hover:underline`}>
          <AppLink
            to={RouteUtil.populateRouteParams(RouteMap[PageMap.TRACE_VIEW]!, {
              modelId: traceIdHex,
            })}
          >
            <p>{traceIdHex}</p>
          </AppLink>
        </div>
      ) : (
        <></>
      )}
    </div>
  );
};

export default TraceElement;
