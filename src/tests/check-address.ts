import { DlmsClient, InterfaceType } from "@bubblyworld/gurux-dlms-ts";

for (const serverAddress of [6452, 16384 + 6452, 25348]) {
  const client = await DlmsClient.create({
    clientAddress: 1,
    serverAddress,
    password: "00000000",
    interfaceType: InterfaceType.HDLC,
  });

  const frames = client.snrmRequest();

  console.log(`\nserverAddress=${serverAddress}`);

  for (const frame of frames) {
    console.log(Buffer.from(frame).toString("hex").toUpperCase());
  }

  client.free();
}