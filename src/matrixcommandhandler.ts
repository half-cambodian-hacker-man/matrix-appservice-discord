/*
Copyright 2019 matrix-appservice-discord

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { DiscordBot } from "./bot";
import { Log } from "./log";
import { DiscordBridgeConfig } from "./config";
import { Bridge, BridgeContext } from "matrix-appservice-bridge";
import { IMatrixEvent } from "./matrixtypes";
import { Provisioner } from "./provisioner";
import { Util, ICommandActions, ICommandParameters, CommandPermissonCheck } from "./util";
import * as Discord from "discord.js";
import * as markdown from "discord-markdown";
import { RemoteStoreRoom } from "./db/roomstore";
const log = new Log("MatrixCommandHandler");

/* tslint:disable:no-magic-numbers */
const PROVISIONING_DEFAULT_POWER_LEVEL = 50;
const PROVISIONING_DEFAULT_USER_POWER_LEVEL = 0;
const ROOM_CACHE_MAXAGE_MS = 15 * 60 * 1000;
/* tslint:enable:no-magic-numbers */

export class MatrixCommandHandler {
    private botJoinedRooms: Set<string> = new Set(); // roomids
    private botJoinedRoomsCacheUpdatedAt = 0;
    private provisioner: Provisioner;
    constructor(
        private discord: DiscordBot,
        private bridge: Bridge,
        private config: DiscordBridgeConfig,
    ) {
        this.provisioner = this.discord.Provisioner;
    }

    public async HandleInvite(event: IMatrixEvent) {
        log.info(`Received invite for ${event.state_key} in room ${event.room_id}`);
        await this.bridge.getIntent().join(event.room_id);
        this.botJoinedRooms.add(event.room_id);
    }

    public async Process(event: IMatrixEvent, context: BridgeContext) {
        if (!(await this.isBotInRoom(event.room_id))) {
            log.warn(`Bot is not in ${event.room_id}. Ignoring command`);
            return;
        }

        const actions: ICommandActions = {
            bridge: {
                description: "Bridges this room to a Discord channel",
                // tslint:disable prefer-template
                help: "How to bridge a Discord guild:\n" +
                    "1. Invite the bot to your Discord guild using this link: " + Util.GetBotLink(this.config) + "\n" +
                    "2. Invite me to the matrix room you'd like to bridge\n" +
                    "3. Open the Discord channel you'd like to bridge in a web browser\n" +
                    "4. In the matrix room, send the message `!discord bridge <guild id> <channel id>` " +
                    "(without the backticks)\n" +
                    "   Note: The Guild ID and Channel ID can be retrieved from the URL in your web browser.\n" +
                    "   The URL is formatted as https://discordapp.com/channels/GUILD_ID/CHANNEL_ID\n" +
                    "5. Enjoy your new bridge!",
                // tslint:enable prefer-template
                params: ["guildId", "channelId"],
                permission: {
                    cat: "events",
                    level: PROVISIONING_DEFAULT_POWER_LEVEL,
                    selfService: true,
                    subcat: "m.room.power_levels",
                },
                run: async ({guildId, channelId}) => {
                    if (context.rooms.remote) {
                        return "This room is already bridged to a Discord guild.";
                    }
                    if (!guildId || !channelId) {
                        return "Invalid syntax. For more information try `!discord help bridge`";
                    }
                    try {
                        const discordResult = await this.discord.LookupRoom(guildId, channelId, event.sender);
                        const channel = discordResult.channel as Discord.TextChannel;

                        log.info(`Bridging matrix room ${event.room_id} to ${guildId}/${channelId}`);
                        this.bridge.getIntent().sendMessage(event.room_id, {
                            body: "I'm asking permission from the guild administrators to make this bridge.",
                            msgtype: "m.notice",
                        });

                        // await this.provisioner.AskBridgePermission(channel, event.sender);
                        await this.provisioner.BridgeMatrixRoom(channel, event.room_id);
                        return "I have bridged this room to your channel";
                    } catch (err) {
                        if (err.message === "Timed out waiting for a response from the Discord owners"
                            || err.message === "The bridge has been declined by the Discord guild") {
                            return err.message;
                        }

                        log.error(`Error bridging ${event.room_id} to ${guildId}/${channelId}`);
                        log.error(err);
                        return "There was a problem bridging that channel - has the guild owner approved the bridge?";
                    }
                },
            },
            unbridge: {
                description: "Unbridges a Discord channel from this room",
                params: [],
                permission: {
                    cat: "events",
                    level: PROVISIONING_DEFAULT_POWER_LEVEL,
                    selfService: true,
                    subcat: "m.room.power_levels",
                },
                run: async () => {
                    const remoteRoom = context.rooms.remote as RemoteStoreRoom;
                    if (!remoteRoom) {
                        return "This room is not bridged.";
                    }
                    if (!remoteRoom.data.plumbed) {
                        return "This room cannot be unbridged.";
                    }
                    const res = await this.discord.LookupRoom(
                        remoteRoom.data.discord_guild!,
                        remoteRoom.data.discord_channel!,
                        event.sender
                    );
                    try {
                        await this.provisioner.UnbridgeChannel(res.channel, event.room_id);
                        return "This room has been unbridged";
                    } catch (err) {
                        log.error("Error while unbridging room " + event.room_id);
                        log.error(err);
                        return "There was an error unbridging this room. " +
                            "Please try again later or contact the bridge operator.";
                    }
                },
            },
        };

        /*
        We hack together that "guildId/channelId" is the same as "guildId channelId".
        We do this by assuming that guildId is parsed first, and split at "/"
        The first element is returned, the second one is passed on to channelId, if applicable.
        */
        let guildIdRemainder: string | undefined;
        const parameters: ICommandParameters = {
            channelId: {
                description: "The ID of a channel on discord",
                get: async (s) => {
                    if (!s && guildIdRemainder) {
                        return guildIdRemainder;
                    }
                    return s;
                },
            },
            guildId: {
                description: "The ID of a guild/server on discord",
                get: async (s) => {
                    if (!s) {
                        return s;
                    }
                    const parts = s.split("/");
                    guildIdRemainder = parts[1];
                    return parts[0];
                },
            },
        };

        const permissionCheck: CommandPermissonCheck = async (permission) => {
            if (permission.selfService && !this.config.bridge.enableSelfServiceBridging) {
                return "The owner of this bridge does not permit self-service bridging.";
            }
            return await Util.CheckMatrixPermission(
                this.bridge.getIntent().getClient(),
                event.sender,
                event.room_id,
                permission.level,
                permission.cat,
                permission.subcat,
            );
        };

        const reply = await Util.ParseCommand("!discord", event.content!.body!, actions, parameters, permissionCheck);
        const formattedReply = markdown.toHTML(reply);

        await this.bridge.getIntent().sendMessage(event.room_id, {
            body: reply,
            format: "org.matrix.custom.html",
            formatted_body: formattedReply,
            msgtype: "m.notice",
        });
    }

    private async isBotInRoom(roomId: string): Promise<boolean> {
        // Update the room cache, if not done already.
        if (Date.now () - this.botJoinedRoomsCacheUpdatedAt > ROOM_CACHE_MAXAGE_MS) {
            log.verbose("Updating room cache for bot...");
            try {
                log.verbose("Got new room cache for bot");
                this.botJoinedRoomsCacheUpdatedAt = Date.now();
                const rooms = (await this.bridge.getBot().getJoinedRooms()) as string[];
                this.botJoinedRooms = new Set(rooms);
            } catch (e) {
                log.error("Failed to get room cache for bot, ", e);
                return false;
            }
        }
        return this.botJoinedRooms.has(roomId);
    }
}
