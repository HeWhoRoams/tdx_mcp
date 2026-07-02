#!/usr/bin/env node

import axios from 'axios';

async function testAuth() {
  try {
    const baseUrl = 'https://cmich.teamdynamix.com/TDWebApi/api';
    console.log('Testing authentication at:', baseUrl);
    console.log('Using BEID:', '235B0D9F-A302-4F2F-AECE-960F149DB112');
    
    const response = await axios.post(`${baseUrl}/auth/loginadmin`, {
      BEID: '235B0D9F-A302-4F2F-AECE-960F149DB112',
      WebServicesKey: '84F94A77-1C3A-464E-B6FB-77218FFA4CC7'
    });
    
    console.log('✅ Authentication successful!');
    console.log('Token:', response.data.substring(0, 50) + '...');
    
  } catch (error) {
    console.error('❌ Authentication failed');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Headers:', error.response.headers);
      console.error('Data:', error.response.data);
    } else if (error.request) {
      console.error('No response received:', error.message);
    } else {
      console.error('Error:', error.message);
    }
  }
}

testAuth();
