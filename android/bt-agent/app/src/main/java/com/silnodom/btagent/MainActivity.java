package com.silnodom.btagent;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(48, 48, 48, 48);

        TextView title = new TextView(this);
        title.setText("BT Agent");
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        layout.addView(title);

        TextView sub = new TextView(this);
        sub.setText("HTTP server on port 8765");
        sub.setTextSize(14);
        sub.setGravity(Gravity.CENTER);
        layout.addView(sub);

        Button startBtn = new Button(this);
        startBtn.setText("Start Service");
        startBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startService();
            }
        });
        layout.addView(startBtn);

        setContentView(layout);

        // Auto-start on launch
        startService();
    }

    private void startService() {
        Intent svc = new Intent(this, BtAgentService.class);
        startForegroundService(svc);
    }
}
