package com.silnodom.btagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;

public class BtAgentService extends Service {

    private static final String TAG = "BtAgentService";
    private static final int PORT = 8765;
    private static final int NOTIF_ID = 1;
    private static final String CHANNEL_ID = "bt_agent";

    private ServerSocket serverSocket;
    private Thread serverThread;
    private volatile boolean running = false;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createNotificationChannel();
        startForeground(NOTIF_ID, buildNotification("Running on port " + PORT));
        startServer();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (serverSocket != null) {
            try { serverSocket.close(); } catch (IOException ignored) {}
        }
        if (serverThread != null) serverThread.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ─── HTTP server ──────────────────────────────────────────────────────────

    private void startServer() {
        running = true;
        serverThread = new Thread(() -> {
            try {
                serverSocket = new ServerSocket(PORT, 10, InetAddress.getByName("0.0.0.0"));
                Log.i(TAG, "Listening on " + PORT);
                updateNotification("Listening on :" + PORT);
                while (running) {
                    try {
                        Socket client = serverSocket.accept();
                        new Thread(() -> handleClient(client)).start();
                    } catch (IOException e) {
                        if (running) Log.w(TAG, "accept error", e);
                    }
                }
            } catch (IOException e) {
                Log.e(TAG, "Server failed to start", e);
                updateNotification("ERROR: " + e.getMessage());
            }
        });
        serverThread.setDaemon(true);
        serverThread.start();
    }

    private void handleClient(Socket client) {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream()));
             OutputStream out = client.getOutputStream()) {

            String requestLine = in.readLine();
            if (requestLine == null || requestLine.isEmpty()) return;

            // Consume headers
            String line;
            while ((line = in.readLine()) != null && !line.isEmpty()) {}

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String path = parts[1].split("\\?")[0];

            // CORS preflight
            if ("OPTIONS".equals(method)) {
                writeResponse(out, 200, "{}", true);
                return;
            }

            String body;
            int status;

            if ("/bt-toggle".equals(path)) {
                BluetoothAdapter bt = BluetoothAdapter.getDefaultAdapter();
                if (bt == null) {
                    body = "{\"ok\":false,\"error\":\"no_adapter\"}";
                    status = 500;
                } else {
                    boolean wasEnabled = bt.isEnabled();
                    if (wasEnabled) bt.disable(); else bt.enable();
                    String state = wasEnabled ? "disabled" : "enabled";
                    body = "{\"ok\":true,\"state\":\"" + state + "\",\"was_enabled\":" + wasEnabled + "}";
                    status = 200;
                    Log.i(TAG, "BT toggle: " + (wasEnabled ? "ON→OFF" : "OFF→ON"));
                }
            } else if ("/bt-status".equals(path)) {
                BluetoothAdapter bt = BluetoothAdapter.getDefaultAdapter();
                boolean enabled = bt != null && bt.isEnabled();
                body = "{\"ok\":true,\"enabled\":" + enabled + "}";
                status = 200;
            } else {
                body = "{\"error\":\"not_found\",\"path\":\"" + path + "\"}";
                status = 404;
            }

            writeResponse(out, status, body, false);

        } catch (IOException e) {
            Log.w(TAG, "Client error", e);
        } finally {
            try { client.close(); } catch (IOException ignored) {}
        }
    }

    private void writeResponse(OutputStream out, int status, String body, boolean corsOnly) throws IOException {
        byte[] bodyBytes = body.getBytes("UTF-8");
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append(" OK\r\n");
        sb.append("Content-Type: application/json\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Methods: GET, OPTIONS\r\n");
        sb.append("Access-Control-Allow-Headers: Content-Type\r\n");
        sb.append("Connection: close\r\n");
        sb.append("Content-Length: ").append(bodyBytes.length).append("\r\n");
        sb.append("\r\n");
        out.write(sb.toString().getBytes("UTF-8"));
        if (!corsOnly) out.write(bodyBytes);
        out.flush();
    }

    // ─── Notification ─────────────────────────────────────────────────────────

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "BT Agent", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Bluetooth HTTP agent");
        channel.setShowBadge(false);
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("BT Agent")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification(text));
    }
}
